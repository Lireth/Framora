/**
 * 感知哈希纯函数核心：dHash 64-bit 打包 / 汉明距离 / 可扩展贪心聚类。
 * 无任何依赖，便于单元测试。
 */

/** 9×8 灰度像素缓冲打包为 64-bit dHash（相邻水平像素比较），拆成两个 32 位无符号整数 */
export function packDhashBits(data: Uint8Array): { lo: number; hi: number } {
  let hi = 0
  let lo = 0
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const bit = data[row * 9 + col] > data[row * 9 + col + 1] ? 1 : 0
      const idx = row * 8 + col
      if (idx < 32) hi = (hi << 1) | bit
      else lo = (lo << 1) | bit
    }
  }
  return { lo: lo >>> 0, hi: hi >>> 0 }
}

export function popcount32(v: number): number {
  v = v >>> 0
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  v = (v + (v >>> 4)) & 0x0f0f0f0f
  return ((v * 0x01010101) >>> 24) & 0x3f
}

/** 两个 64 位哈希（高低 32 位对）的汉明距离 */
export function hamming64(a: { lo: number; hi: number }, b: { lo: number; hi: number }): number {
  return popcount32((a.hi ^ b.hi) >>> 0) + popcount32((a.lo ^ b.lo) >>> 0)
}

/** 感知哈希行（高低 32 位对） */
export interface PhashRow {
  id: number
  lo: number
  hi: number
}

/** 可选的聚类诊断计数：候选簇数量与实际汉明比较次数（测试/性能观测用） */
export interface ClusterStats {
  candidates: number
  comparisons: number
}

const CHUNK_COUNT = 4
const CHUNK_BITS = 16

/**
 * 按位交织把 64 位哈希拆成 4 个 16 位块：第 p 位进入第 p % 4 块。
 *
 * 不直接按连续 16 位切块，是因为 dHash 相邻位对应同一行相邻列，高度相关；
 * 交织后每块都跨越 8 行梯度，桶分布更均匀，避免大量照片挤进同一个桶。
 */
export function splitHashChunks(lo: number, hi: number): [number, number, number, number] {
  let c0 = 0
  let c1 = 0
  let c2 = 0
  let c3 = 0
  lo >>>= 0
  hi >>>= 0
  for (let p = 0; p < 64; p++) {
    const bit = p < 32 ? (lo >>> p) & 1 : (hi >>> (p - 32)) & 1
    switch (p & 3) {
      case 0:
        c0 = (c0 << 1) | bit
        break
      case 1:
        c1 = (c1 << 1) | bit
        break
      case 2:
        c2 = (c2 << 1) | bit
        break
      default:
        c3 = (c3 << 1) | bit
    }
  }
  return [c0, c1, c2, c3]
}

interface IndexedCluster {
  lo: number
  hi: number
  chunks: [number, number, number, number]
  members: number[]
}

function collectBucket(
  list: number[] | undefined,
  stamp: Uint32Array,
  gen: number,
  out: number[],
): void {
  if (!list) return
  for (let i = 0; i < list.length; i++) {
    const ci = list[i]
    if (stamp[ci] === gen) continue // 同一行经多个块/变体重复命中
    stamp[ci] = gen
    out.push(ci)
  }
}

/**
 * 分块索引贪心聚类，语义与逐簇线性扫描完全一致：
 * 每行仍归入「创建顺序最早、代表哈希距离 ≤ threshold」的簇，否则自立新簇。
 *
 * 索引原理（鸽巢）：64 位拆成 4 块、距离上限为 t 时，必有一块的块内距离
 * ≤ floor(t / 4)。默认阈值 6 即每块枚举全部 1 位翻转（17 个键 × 4 块 = 68 次查表），
 * 候选集保证是所有真实近邻的超集，不会漏簇；随后按候选簇编号取最小命中。
 * 随机分布下每行候选约 n / 1000，十万张库从十亿级比较降到百万级。
 *
 * 阈值 > 11 时每块半径 ≥3、变体枚举（697/块）已超过暴力扫描成本，退回精确线性路径。
 */
export function clusterPhashes(rows: PhashRow[], threshold = 6, stats?: ClusterStats): number[][] {
  const t = Number.isFinite(threshold) ? Math.floor(threshold) : -1
  const radius = t < 0 ? -1 : Math.floor(t / CHUNK_COUNT)
  if (radius < 0 || radius > 2) return clusterPhashesLinear(rows, threshold, stats)

  const clusters: IndexedCluster[] = []
  const buckets: Map<number, number[]>[] = []
  for (let i = 0; i < CHUNK_COUNT; i++) buckets.push(new Map())
  // 簇数量上界即行数；标记数组用行号代次去重，避免每行分配 Set
  const stamp = new Uint32Array(Math.max(1, rows.length))
  const candidates: number[] = []
  let stampGen = 0

  for (const row of rows) {
    const lo = row.lo >>> 0
    const hi = row.hi >>> 0
    const chunks = splitHashChunks(lo, hi)

    stampGen++
    if (stampGen > 0x7fffffff) {
      stamp.fill(0)
      stampGen = 1
    }
    candidates.length = 0
    for (let ci = 0; ci < CHUNK_COUNT; ci++) {
      const map = buckets[ci]
      const v = chunks[ci]
      collectBucket(map.get(v), stamp, stampGen, candidates)
      if (radius >= 1) {
        for (let b = 0; b < CHUNK_BITS; b++) {
          collectBucket(map.get(v ^ (1 << b)), stamp, stampGen, candidates)
        }
      }
      if (radius >= 2) {
        for (let a = 0; a < CHUNK_BITS; a++) {
          for (let b = a + 1; b < CHUNK_BITS; b++) {
            collectBucket(map.get(v ^ (1 << a) ^ (1 << b)), stamp, stampGen, candidates)
          }
        }
      }
    }
    if (stats) stats.candidates += candidates.length

    let best = -1
    for (let k = 0; k < candidates.length; k++) {
      const ci = candidates[k]
      // 只关心最小簇号：已有更早命中时，更大的候选不可能改变结果
      if (best >= 0 && ci >= best) continue
      const c = clusters[ci]
      if (stats) stats.comparisons++
      if (popcount32((hi ^ c.hi) >>> 0) + popcount32((lo ^ c.lo) >>> 0) <= t) best = ci
    }

    if (best >= 0) {
      clusters[best].members.push(row.id)
      continue
    }
    const idx = clusters.length
    clusters.push({ lo, hi, chunks, members: [row.id] })
    for (let ci = 0; ci < CHUNK_COUNT; ci++) {
      const map = buckets[ci]
      const key = chunks[ci]
      const list = map.get(key)
      if (list) list.push(idx)
      else map.set(key, [idx])
    }
  }

  const out: number[][] = []
  for (const c of clusters) if (c.members.length > 1) out.push(c.members)
  return out
}

/** 精确线性聚类：仅在阈值大到索引枚举不划算时使用，行为与原实现逐字节一致 */
function clusterPhashesLinear(
  rows: PhashRow[],
  threshold: number,
  stats?: ClusterStats,
): number[][] {
  const clusters: { lo: number; hi: number; members: number[] }[] = []
  for (const r of rows) {
    let hit = -1
    for (let i = 0; i < clusters.length; i++) {
      if (stats) stats.comparisons++
      if (hamming64(r, clusters[i]) <= threshold) {
        hit = i
        break
      }
    }
    if (hit >= 0) clusters[hit].members.push(r.id)
    else clusters.push({ lo: r.lo, hi: r.hi, members: [r.id] })
  }
  return clusters.map((c) => c.members).filter((m) => m.length > 1)
}
