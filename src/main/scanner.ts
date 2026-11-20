import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow } from 'electron'
import {
  addFolder,
  findPhotoByPath,
  getFolderByPath,
  insertPhoto,
  listPhotoRowsByFolder,
  updatePhotoFileFields
} from './db'
import { enqueueThumb } from './thumbs'
import type { ImportResult, ScanEvent, WatchEvent } from '@shared/types'

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

export async function importFolder(folderPath: string): Promise<ImportResult> {
  const st = await fs.promises.stat(folderPath).catch(() => null)
  if (!st || !st.isDirectory()) throw new Error('所选路径不是有效的文件夹')
  const existing = getFolderByPath(folderPath)
  const folderId = existing ? existing.id : addFolder(folderPath, path.basename(folderPath))
  broadcastScan({ phase: 'start', folderId })
  let found = 0
  let added = 0
  let updated = 0
  const known = new Map<string, { id: number; mtime: number; size: number; missing: number }>()
  for (const r of listPhotoRowsByFolder(folderId)) {
    known.set(r.path.toLowerCase(), r)
  }
  const now = Date.now()
  try {
    for await (const file of walk(folderPath)) {
      found++
      const s = await fs.promises.stat(file).catch(() => null)
      if (!s) continue
      const mtime = Math.round(s.mtimeMs)
      const size = s.size
      const k = known.get(file.toLowerCase())
      if (!k) {
        const id = insertPhoto({
          folder_id: folderId,
          path: file,
          name: path.basename(file),
          ext: path.extname(file).toLowerCase().slice(1),
          size,
          mtime,
          imported_at: now
        })
        added++
        enqueueThumb(id)
      } else if (k.mtime !== mtime || k.size !== size) {
        updatePhotoFileFields(k.id, { size, mtime })
        enqueueThumb(k.id)
        updated++
      } else if (k.missing) {
        updatePhotoFileFields(k.id, { missing: 0 })
      }
    }
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
    .catch(() => undefined)
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
    .catch(() => undefined)
}

export function trackDeletedFile(folderId: number, filePath: string): void {
  const row = findPhotoByPath(filePath)
  if (!row) return
  updatePhotoFileFields(row.id, { missing: 1 })
  broadcastWatch({ type: 'unlink', folderId, id: row.id })
}
