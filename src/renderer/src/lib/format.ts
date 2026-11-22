// 数值/日期展示格式化单一事实源在 @shared/formats，此处转发保持既有导入路径稳定
export { formatBytes, formatCount, formatDate, formatDateTime } from '@shared/formats'

import { isRawExt } from '@shared/formats'

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

/** 纯字符串实现的父目录（渲染层无 node:path；兼容正反斜杠） */
export function parentDir(p: string): string {
  const sep = String.fromCharCode(92)
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf(sep))
  return idx > 0 ? p.slice(0, idx) : p
}

export function thumbUrl(p: { id: number; thumb_ts: number }): string {
  return `thumb://t/${p.id}.webp?v=${p.thumb_ts}`
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
  return isRawExt(p.ext) ? previewUrl(p) : mediaUrl(p)
}
