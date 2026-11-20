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

export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  const wrapped = (...args: Parameters<T>): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }
  return wrapped as T
}

export function mediaUrl(p: { path: string; mtime?: number }): string {
  return `media://img/?p=${encodeURIComponent(p.path)}&v=${p.mtime ?? 0}`
}

export function thumbUrl(p: { id: number; thumb_ts: number }): string {
  return `thumb://t/${p.id}.webp?v=${p.thumb_ts}`
}

/** RAW 扩展名：浏览器无法直接渲染，查看器改用提取的嵌入预览 */
const RAW_EXTS = new Set(['cr2', 'cr3', 'nef', 'nrw', 'arw', 'raf', 'dng', 'rw2', 'orf', 'pef'])

export function isRawPhoto(p: { ext: string }): boolean {
  return RAW_EXTS.has(p.ext.toLowerCase())
}

export function previewUrl(p: { id: number; thumb_ts: number }): string {
  return `thumb://t/${p.id}.preview.jpg?v=${p.thumb_ts}`
}

/** 查看器显示源：RAW 用嵌入预览，其余用原文件 */
export function displayUrl(p: {
  path: string
  mtime?: number
  id: number
  thumb_ts: number
  ext: string
}): string {
  return isRawPhoto(p) ? previewUrl(p) : mediaUrl(p)
}
