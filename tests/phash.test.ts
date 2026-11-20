import { describe, expect, it } from 'vitest'
import { clusterPhashes, hamming64, packDhashBits, popcount32 } from '../src/main/phashCore'

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
      mk(4, 0x55555555, 0xaaaaaaaa) // 完全不同
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
