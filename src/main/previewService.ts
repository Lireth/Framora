/**
 * RAW 预览按需重建：预览缓存按预算淘汰后，thumb:// 协议首次请求时从 RAW 嵌入段即时提取。
 * 同一张照片的并发请求合并为一次提取（查看器预取相邻照片时常见）。
 */
import fs from 'node:fs'
import { getPhotoRow } from './db'
import { extractRawPreview } from './rawPreview'
import { schedulePreviewBudgetCheck, writePreviewFile } from './thumbs'
import { isRawExt } from '@shared/formats'

const PREVIEW_SUFFIX = '.preview.jpg'

export function isPreviewFileName(name: string): boolean {
  return name.endsWith(PREVIEW_SUFFIX)
}

/** 从 `{id}.preview.jpg` 解析照片 id；非预览文件名返回 null */
export function previewIdFromName(name: string): number | null {
  if (!isPreviewFileName(name)) return null
  const id = Number(name.slice(0, -PREVIEW_SUFFIX.length))
  return Number.isInteger(id) && id > 0 ? id : null
}

const inflight = new Map<number, Promise<void>>()

/** 确保预览文件存在；失败（非 RAW / 文件丢失 / 无嵌入预览）时静默返回，由调用方回 404 */
export async function ensurePreview(id: number, target: string): Promise<void> {
  if (fs.existsSync(target)) return
  const pending = inflight.get(id)
  if (pending) return pending
  const task = (async (): Promise<void> => {
    const row = getPhotoRow(id)
    if (!row || row.missing || !isRawExt(row.ext)) return
    if (!fs.existsSync(row.path)) return
    const buf = await extractRawPreview(row.path)
    if (!buf?.length) return
    await writePreviewFile(target, buf)
    // 预算清理可能立刻淘汰旧预览；本次写入的 mtime 最新，会保留在缓存中
    schedulePreviewBudgetCheck()
  })()
  inflight.set(id, task)
  try {
    await task
  } finally {
    inflight.delete(id)
  }
}
