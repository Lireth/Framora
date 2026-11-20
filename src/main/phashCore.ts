/**
 * 感知哈希纯函数核心：dHash 64-bit 打包 / 汉明距离 / 贪心聚类。
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

/**
 * 贪心聚类：每张照片与既有簇代表比较，距离 ≤ threshold 归入该簇，否则自立新簇。
 * 返回成员数 ≥ 2 的簇（疑似重复组），簇内按输入顺序排列。
 */
export function clusterPhashes(
  rows: { id: number; lo: number; hi: number }[],
  threshold = 6
): number[][] {
  const clusters: { lo: number; hi: number; members: number[] }[] = []
  for (const r of rows) {
    const hit = clusters.find((c) => hamming64(r, c) <= threshold)
    if (hit) hit.members.push(r.id)
    else clusters.push({ lo: r.lo, hi: r.hi, members: [r.id] })
  }
  return clusters.map((c) => c.members).filter((m) => m.length > 1)
}
