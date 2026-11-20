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

/* eslint-disable @typescript-eslint/no-explicit-any */
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
