/**
 * 照片格式常量与展示格式化：主进程 / 渲染进程共享的单一事实源，无运行环境依赖。
 * 扩展名统一不带点（如 'jpg'），完整路径的扩展名解析由主进程调用方完成。
 */

/* ---------- 文件格式 ---------- */

/** RAW 相机格式：sharp 预编译 libvips 不含 libraw，仅能取嵌入预览用于显示与导出 */
export const RAW_EXTS = ['cr2', 'cr3', 'nef', 'nrw', 'arw', 'raf', 'dng', 'rw2', 'orf', 'pef'] as const

/** 全部支持的照片扩展名（不含点），由普通格式与 RAW 格式合成 */
export const IMAGE_EXTS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'avif',
  'tif',
  'tiff',
  'heic',
  'heif',
  ...RAW_EXTS
] as const

export const IMAGE_EXT_SET: ReadonlySet<string> = new Set(IMAGE_EXTS)

const RAW_EXT_SET: ReadonlySet<string> = new Set(RAW_EXTS)

/** 归一化扩展名：兼容带点/不带点输入，统一小写 */
export function normalizeExt(ext: string): string {
  return ext.toLowerCase().replace(/^\./, '')
}

/** 是否 RAW 格式（按已提取的扩展名判断，兼容带点/大小写输入） */
export function isRawExt(ext: string): boolean {
  return RAW_EXT_SET.has(normalizeExt(ext))
}

/* ---------- 展示格式化 ---------- */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const pad = (v: number): string => String(v).padStart(2, '0')

export function formatDate(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${formatDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatCount(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n)
}
