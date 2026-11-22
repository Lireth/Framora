import { describe, expect, it } from 'vitest'
import { IMAGE_EXTS, KNOWN_UNSUPPORTED_EXTS, RAW_EXTS, isRawExt } from '@shared/formats'
import { SETTING_READ_KEYS, SETTING_WRITE_KEYS } from '@shared/types'
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

describe('设置键注册表（OPT-32 写 / OPT-47 读）', () => {
  it('写侧白名单仅含 UI 状态键', () => {
    for (const k of ['theme', 'viewState', 'searchHistory']) {
      expect(SETTING_WRITE_KEYS.has(k)).toBe(true)
    }
    // 预算/阈值有专用通道；撤销栈/预设/窗口位置为主进程内部状态
    expect(SETTING_WRITE_KEYS.has('previewBudgetMb')).toBe(false)
    expect(SETTING_WRITE_KEYS.has('undoStack')).toBe(false)
    expect(SETTING_WRITE_KEYS.has('editPresets')).toBe(false)
  })

  it('读侧白名单覆盖渲染层实际读取的全部键且不含内部状态', () => {
    // 与渲染层 api.getSetting 调用点保持一致：theme/searchHistory/viewState/phashThreshold
    for (const k of ['theme', 'viewState', 'searchHistory', 'phashThreshold']) {
      expect(SETTING_READ_KEYS.has(k)).toBe(true)
    }
    expect(SETTING_READ_KEYS.has('undoStack')).toBe(false)
    expect(SETTING_READ_KEYS.has('windowBounds')).toBe(false)
    expect(SETTING_READ_KEYS.has('editPresets')).toBe(false)
  })
})
