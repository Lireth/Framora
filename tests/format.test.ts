import { describe, expect, it } from 'vitest'
import { IMAGE_EXTS, KNOWN_UNSUPPORTED_EXTS, RAW_EXTS, isRawExt } from '@shared/formats'
import { formatBytes, formatCount, formatDate, formatDateTime, mediaUrl, thumbUrl } from '../src/renderer/src/lib/format'

describe('formatBytes', () => {
  it('按单位阶梯格式化', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3.5 * 1024 * 1024 * 1024)).toBe('3.50 GB')
  })
})

describe('formatDate / formatDateTime', () => {
  it('空值显示占位符', () => {
    expect(formatDate(null)).toBe('—')
    expect(formatDateTime(undefined)).toBe('—')
  })
  it('格式化为本地日期时间', () => {
    const ts = new Date(2026, 2, 5, 8, 7).getTime() // 本地时区 2026-03-05 08:07
    expect(formatDate(ts)).toBe('2026-03-05')
    expect(formatDateTime(ts)).toBe('2026-03-05 08:07')
  })
})

describe('formatCount', () => {
  it('万级转换单位', () => {
    expect(formatCount(9999)).toBe('9999')
    expect(formatCount(30000)).toBe('3.0 万')
  })
})

describe('mediaUrl / thumbUrl', () => {
  it('路径与版本参数被正确编码', () => {
    const url = mediaUrl({ path: 'D:\\pic\\a b.jpg', mtime: 42 })
    expect(url).toContain('media://img/?p=')
    expect(url).toContain('v=42')
    expect(thumbUrl({ id: 7, thumb_ts: 99 })).toBe('thumb://t/7.webp?v=99')
  })
})

describe('shared formats（RAW 单一事实源不变量）', () => {
  it('全部 RAW 扩展名均包含于 IMAGE_EXTS，新增 RAW 无需多处同步', () => {
    for (const ext of RAW_EXTS) expect(IMAGE_EXTS).toContain(ext)
  })
  it('isRawExt 兼容带点/大小写输入', () => {
    expect(isRawExt('cr2')).toBe(true)
    expect(isRawExt('.CR3')).toBe(true)
    expect(isRawExt('jpg')).toBe(false)
    expect(isRawExt('')).toBe(false)
  })
  it('HEIC/HEIF 登记为已知不支持格式，且未混入支持集合', () => {
    for (const ext of KNOWN_UNSUPPORTED_EXTS) {
      expect(IMAGE_EXTS).not.toContain(ext)
    }
    expect(KNOWN_UNSUPPORTED_EXTS).toEqual(['heic', 'heif'])
  })
})
