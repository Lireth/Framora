import { describe, expect, it } from 'vitest'
import {
  clusterPhashes,
  hamming64,
  packDhashBits,
  popcount32,
  splitHashChunks,
  type PhashRow,
} from '../src/main/phashCore'

describe('popcount32', () => {
  it('统计置位数量', () => {
    expect(popcount32(0)).toBe(0)
    expect(popcount32(0xffffffff)).toBe(32)
    expect(popcount32(0b1011)).toBe(3)
    expect(popcount32(0x80000000)).toBe(1)
  })
})

describe('packDhashBits', () => {
  it('左亮右暗渐变 → 全 1 哈希（left > right 全部置位）', () => {
    const data = new Uint8Array(8 * 9)
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 9; col++) data[row * 9 + col] = 255 - col * 28
    }
    const { lo, hi } = packDhashBits(data)
    expect(hi).toBe(0xffffffff)
    expect(lo).toBe(0xffffffff)
  })

  it('左暗右亮渐变 → 全 0 哈希', () => {
    const data = new Uint8Array(8 * 9)
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 9; col++) data[row * 9 + col] = col * 28
    }
    const { lo, hi } = packDhashBits(data)
    expect(hi).toBe(0)
    expect(lo).toBe(0)
  })

  it('相同输入产生相同哈希', () => {
    const data = new Uint8Array(8 * 9).map((_, i) => (i * 37) % 256)
    expect(packDhashBits(data)).toEqual(packDhashBits(data))
  })
})

describe('hamming64 / clusterPhashes', () => {
  const mk = (id: number, lo: number, hi: number) => ({ id, lo, hi })

  it('汉明距离按位计算', () => {
    expect(hamming64(mk(1, 0, 0), mk(2, 0, 0))).toBe(0)
    expect(hamming64(mk(1, 0x00000001, 0), mk(2, 0, 0x00000001))).toBe(2)
    expect(hamming64(mk(1, 0xffffffff, 0xffffffff), mk(2, 0, 0))).toBe(64)
  })

  it('相同/近似哈希聚为一组，孤立哈希不出现', () => {
    const rows = [
      mk(1, 0x12345678, 0x9abcdef0),
      mk(2, 0x12345678, 0x9abcdef0), // 完全相同
      mk(3, 0x12345679, 0x9abcdef0), // 距离 1
      mk(4, 0x55555555, 0xaaaaaaaa), // 完全不同
    ]
    const groups = clusterPhashes(rows, 6)
    expect(groups.length).toBe(1)
    expect(groups[0]).toEqual([1, 2, 3])
  })

  it('阈值收紧可拆分近邻组', () => {
    const rows = [mk(1, 0, 0), mk(2, 0x00000007, 0)] // 距离 3
    expect(clusterPhashes(rows, 6).length).toBe(1)
    expect(clusterPhashes(rows, 2).length).toBe(0)
  })
})

/* ---------- 分块索引聚类：正确性与可扩展性 ---------- */

/** 确定性伪随机源（mulberry32），保证用例可复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomHash(rand: () => number): { lo: number; hi: number } {
  return {
    lo: Math.floor(rand() * 0x100000000) >>> 0,
    hi: Math.floor(rand() * 0x100000000) >>> 0,
  }
}

/** 按位位置构造哈希（位置 0..63，避免 1<<31 的符号问题） */
function hashWithBits(positions: number[]): { lo: number; hi: number } {
  let lo = 0
  let hi = 0
  for (const p of positions) {
    if (p < 32) lo = (lo | (1 << p)) >>> 0
    else hi = (hi | (1 << (p - 32))) >>> 0
  }
  return { lo, hi }
}

function flipBits(
  hash: { lo: number; hi: number },
  positions: number[],
): { lo: number; hi: number } {
  let { lo, hi } = hash
  for (const p of positions) {
    if (p < 32) lo = (lo ^ (1 << p)) >>> 0
    else hi = (hi ^ (1 << (p - 32))) >>> 0
  }
  return { lo, hi }
}

/** 参考实现：改造前的逐簇线性扫描，作为语义基准 */
function referenceCluster(rows: PhashRow[], threshold = 6): number[][] {
  const clusters: { lo: number; hi: number; members: number[] }[] = []
  for (const r of rows) {
    const hit = clusters.find((c) => hamming64(r, c) <= threshold)
    if (hit) hit.members.push(r.id)
    else clusters.push({ lo: r.lo, hi: r.hi, members: [r.id] })
  }
  return clusters.map((c) => c.members).filter((m) => m.length > 1)
}

describe('splitHashChunks', () => {
  it('4 块覆盖全部 64 位，单比特翻转只影响一块', () => {
    const base = hashWithBits([])
    const chunks = splitHashChunks(base.lo, base.hi)
    expect(chunks).toEqual([0, 0, 0, 0])
    for (const p of [0, 7, 16, 31, 32, 47, 63]) {
      const flipped = flipBits(base, [p])
      const next = splitHashChunks(flipped.lo, flipped.hi)
      const changed = next.filter((v, i) => v !== chunks[i])
      expect(changed).toHaveLength(1)
      expect(changed[0]).toBeGreaterThan(0)
      // 块内按 p/4 顺序依次左移，最先写入的位最终落在最高位
      expect(next[p % 4]).toBe(1 << (15 - Math.floor(p / 4)))
    }
  })
})

describe('分块索引聚类', () => {
  const mk = (id: number, lo: number, hi: number): PhashRow => ({ id, lo, hi })

  it('空输入与阈值 0', () => {
    expect(clusterPhashes([])).toEqual([])
    const rows = [mk(1, 0, 0), mk(2, 0, 0), mk(3, 1, 0)]
    expect(clusterPhashes(rows, 0)).toEqual([[1, 2]])
  })

  it('差异分散在多个块时不会漏簇（鸽巢边界）', () => {
    // 6 位差异分布为 2/2/1/1，没有任何一块完全相同，必须靠块内距离 1 命中
    const rows: PhashRow[] = [mk(1, 0, 0), { id: 2, ...hashWithBits([0, 4, 1, 5, 2, 7]) }]
    expect(clusterPhashes(rows, 6)).toEqual([[1, 2]])
    expect(clusterPhashes(rows, 5)).toEqual([])
  })

  it('与逐簇线性扫描结果逐字节一致（含植入近邻与阈值边界）', () => {
    const rand = mulberry32(20261121)
    const rows: PhashRow[] = []
    for (let i = 0; i < 600; i++) rows.push({ id: i + 1, ...randomHash(rand) })
    // 植入近邻：随机取基准，翻转 0..8 位
    for (let i = 0; i < 240; i++) {
      const base = rows[Math.floor(rand() * 600)]
      const flips = Math.floor(rand() * 9)
      const positions: number[] = []
      while (positions.length < flips) {
        const p = Math.floor(rand() * 64)
        if (!positions.includes(p)) positions.push(p)
      }
      rows.push({ id: 601 + i, ...flipBits(base, positions) })
    }

    for (const t of [0, 2, 3, 5, 6, 7, 10, 11]) {
      expect(clusterPhashes(rows, t)).toEqual(referenceCluster(rows, t))
    }
  })

  it('大量完全重复哈希只产生一个簇', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => mk(i + 1, 0x12345678, 0x9abcdef0))
    const stats = { candidates: 0, comparisons: 0 }
    expect(clusterPhashes(rows, 6, stats)).toEqual([rows.map((r) => r.id)])
    expect(stats.comparisons).toBeLessThan(rows.length)
  })

  it('4 万条随机哈希：候选与比较次数远低于两两扫描', () => {
    const rand = mulberry32(42)
    const rows: PhashRow[] = []
    for (let i = 0; i < 40000; i++) rows.push({ id: i + 1, ...randomHash(rand) })
    const stats = { candidates: 0, comparisons: 0 }
    const started = performance.now()
    const groups = clusterPhashes(rows, 6, stats)
    const elapsed = performance.now() - started
    console.log(
      `[phash] 40000 rows: ${elapsed.toFixed(1)}ms, candidates=${stats.candidates}, comparisons=${stats.comparisons}`,
    )
    expect(groups).toEqual([])
    // 线性扫描约 8 亿次比较；索引路径应在每行百次量级
    expect(stats.comparisons).toBeLessThan(rows.length * 100)
    expect(elapsed).toBeLessThan(5000)
  })

  it('近邻密集的图库（300 组 × 40 张连拍近似）仍保持线性量级', () => {
    const rand = mulberry32(7)
    const bases = Array.from({ length: 300 }, () => randomHash(rand))
    const rows: PhashRow[] = []
    for (let i = 0; i < 12000; i++) {
      const positions: number[] = []
      const flips = Math.floor(rand() * 8)
      while (positions.length < flips) {
        const p = Math.floor(rand() * 64)
        if (!positions.includes(p)) positions.push(p)
      }
      rows.push({ id: i + 1, ...flipBits(bases[i % bases.length], positions) })
    }
    const stats = { candidates: 0, comparisons: 0 }
    const started = performance.now()
    const groups = clusterPhashes(rows, 6, stats)
    const elapsed = performance.now() - started
    console.log(
      `[phash] 12000 clustered rows: ${elapsed.toFixed(1)}ms, candidates=${stats.candidates}, comparisons=${stats.comparisons}, groups=${groups.length}`,
    )
    expect(groups.length).toBeGreaterThan(200)
    expect(elapsed).toBeLessThan(3000)
  })
})
