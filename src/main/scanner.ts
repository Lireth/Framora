import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow } from 'electron'
import {
  addFolder,
  findPhotoByPath,
  getFolderByPath,
  insertPhoto,
  insertPhotosBatch,
  listPhotoRowsByFolder,
  updatePhotoFileFields,
  updatePhotoFilesBatch
} from './db'
import { enqueueThumb } from './thumbs'
import { logError } from './log'
import type { ExportEvent, ImportResult, ScanEvent, WatchEvent } from '@shared/types'

export const IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.avif',
  '.tif',
  '.tiff',
  '.heic',
  '.heif'
])

export function isImagePath(p: string): boolean {
  return IMAGE_EXTS.has(path.extname(p).toLowerCase())
}

export function broadcastScan(e: ScanEvent): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('evt:scan', e)
}

export function broadcastWatch(e: WatchEvent): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('evt:watch', e)
}

export function broadcastLibraryChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('evt:library', {})
}

export function broadcastExport(e: ExportEvent): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('evt:export', e)
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      yield* walk(full)
    } else if (e.isFile() && isImagePath(full)) {
      yield full
    }
  }
}

interface FileStat {
  path: string
  size: number
  mtime: number
}

/** 限制并发的批量 stat，避免万级文件逐个 await 串行等待 IO */
async function statAll(
  files: string[],
  concurrency: number,
  onProgress?: (processed: number) => void
): Promise<FileStat[]> {
  const out: (FileStat | null)[] = new Array(files.length).fill(null)
  let cursor = 0
  let done = 0
  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      const i = cursor++
      const s = await fs.promises.stat(files[i]).catch(() => null)
      if (s) out[i] = { path: files[i], size: s.size, mtime: Math.round(s.mtimeMs) }
      done++
      if (onProgress && (done % 200 === 0 || done === files.length)) onProgress(done)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length)) }, worker))
  return out.filter((s): s is FileStat => s !== null)
}

export async function importFolder(folderPath: string): Promise<ImportResult> {
  const st = await fs.promises.stat(folderPath).catch(() => null)
  if (!st || !st.isDirectory()) throw new Error('所选路径不是有效的文件夹')
  const existing = getFolderByPath(folderPath)
  const folderId = existing ? existing.id : addFolder(folderPath, path.basename(folderPath))
  broadcastScan({ phase: 'start', folderId })
  let found: number
  let added: number
  let updated: number
  const now = Date.now()
  try {
    // 1. 收集全部图片文件路径
    const files: string[] = []
    for await (const file of walk(folderPath)) files.push(file)
    found = files.length

    // 2. 并发 stat 后在内存中 diff
    const known = new Map<string, { id: number; mtime: number; size: number; missing: number }>()
    for (const r of listPhotoRowsByFolder(folderId)) {
      known.set(r.path.toLowerCase(), r)
    }
    const stats = await statAll(files, 8, (processed) => {
      broadcastScan({ phase: 'progress', folderId, processed })
    })
    const inserts: {
      folder_id: number
      path: string
      name: string
      ext: string
      size: number
      mtime: number
      imported_at: number
    }[] = []
    const updates: { id: number; size: number; mtime: number }[] = []
    const restores: { id: number; missing: 0 | 1 }[] = []
    for (const s of stats) {
      const k = known.get(s.path.toLowerCase())
      if (!k) {
        inserts.push({
          folder_id: folderId,
          path: s.path,
          name: path.basename(s.path),
          ext: path.extname(s.path).toLowerCase().slice(1),
          size: s.size,
          mtime: s.mtime,
          imported_at: now
        })
      } else if (k.mtime !== s.mtime || k.size !== s.size) {
        updates.push({ id: k.id, size: s.size, mtime: s.mtime })
      } else if (k.missing) {
        restores.push({ id: k.id, missing: 0 })
      }
    }

    // 3. 分批事务写入，避免单批过大占用内存
    const newIds: number[] = []
    const BATCH = 500
    for (let i = 0; i < inserts.length; i += BATCH) {
      newIds.push(...insertPhotosBatch(inserts.slice(i, i + BATCH)))
    }
    for (let i = 0; i < updates.length; i += BATCH) {
      updatePhotoFilesBatch(updates.slice(i, i + BATCH))
    }
    if (restores.length) updatePhotoFilesBatch(restores)
    added = inserts.length
    updated = updates.length

    // 4. 统一入队缩略图生成
    for (const id of newIds) enqueueThumb(id)
    for (const u of updates) enqueueThumb(u.id)

    broadcastScan({ phase: 'done', folderId, found, added, updated })
  } catch (err) {
    broadcastScan({
      phase: 'error',
      folderId,
      message: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
  broadcastLibraryChanged()
  return { folderId, found, added, updated }
}

/** 单文件新增（来自文件监听） */
export function trackNewFile(folderId: number, filePath: string): void {
  if (findPhotoByPath(filePath)) return
  fs.promises
    .stat(filePath)
    .then((s) => {
      const id = insertPhoto({
        folder_id: folderId,
        path: filePath,
        name: path.basename(filePath),
        ext: path.extname(filePath).toLowerCase().slice(1),
        size: s.size,
        mtime: Math.round(s.mtimeMs),
        imported_at: Date.now()
      })
      enqueueThumb(id)
      const row = findPhotoByPath(filePath)
      broadcastWatch({ type: 'add', folderId, photo: row ?? undefined })
    })
    .catch((err) => logError('trackNewFile', err))
}

export function trackChangedFile(folderId: number, filePath: string): void {
  const row = findPhotoByPath(filePath)
  if (!row) {
    trackNewFile(folderId, filePath)
    return
  }
  fs.promises
    .stat(filePath)
    .then((s) => {
      updatePhotoFileFields(row.id, { size: s.size, mtime: Math.round(s.mtimeMs) })
      enqueueThumb(row.id)
      broadcastWatch({ type: 'change', folderId, id: row.id })
    })
    .catch((err) => logError('trackChangedFile', err))
}

export function trackDeletedFile(folderId: number, filePath: string): void {
  const row = findPhotoByPath(filePath)
  if (!row) return
  updatePhotoFileFields(row.id, { missing: 1 })
  broadcastWatch({ type: 'unlink', folderId, id: row.id })
}
