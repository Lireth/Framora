import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow } from 'electron'
import {
  addFolder,
  findDeletedPhotoId,
  findPhotoByPath,
  getFolderByPath,
  insertPhoto,
  insertPhotosBatch,
  listPhotoRowsByFolder,
  restorePhotos,
  updatePhotoFileFields,
  updatePhotoFilesBatch,
  updatePhotoPath
} from './db'
import { enqueueThumb } from './thumbs'
import { logError } from './log'
import { IMAGE_EXT_SET, KNOWN_UNSUPPORTED_EXT_SET, normalizeExt } from '@shared/formats'
import type { ExportEvent, ImportResult, ScanEvent, WatchEvent } from '@shared/types'

/** 扩展名集合单一事实源见 @shared/formats；此处仅做完整路径 → 扩展名的解析判断 */
export function isImagePath(p: string): boolean {
  return IMAGE_EXT_SET.has(normalizeExt(path.extname(p)))
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

async function* walk(
  dir: string,
  onKnownUnsupported?: (p: string) => void,
  token?: { cancelled: boolean }
): AsyncGenerator<string> {
  if (token?.cancelled) return
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (token?.cancelled) return
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      yield* walk(full, onKnownUnsupported, token)
    } else if (e.isFile()) {
      if (isImagePath(full)) yield full
      else if (KNOWN_UNSUPPORTED_EXT_SET.has(normalizeExt(path.extname(full)))) {
        onKnownUnsupported?.(full)
      }
    }
  }
}

/** 进行中的扫描任务（取消标记）：library:cancelScan 使全部在途扫描尽快中止 */
const activeScans = new Set<{ cancelled: boolean }>()

export function cancelScan(): void {
  for (const t of activeScans) t.cancelled = true
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
  onProgress?: (processed: number) => void,
  token?: { cancelled: boolean }
): Promise<FileStat[]> {
  const out: (FileStat | null)[] = new Array(files.length).fill(null)
  let cursor = 0
  let done = 0
  const worker = async (): Promise<void> => {
    while (cursor < files.length && !token?.cancelled) {
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
  // 令牌在任何 await 之前登记，保证调用方同步调用 cancelScan 即可取消本次扫描
  const token = { cancelled: false }
  activeScans.add(token)
  let folderId = 0
  try {
    const st = await fs.promises.stat(folderPath).catch(() => null)
    if (!st || !st.isDirectory()) throw new Error('所选路径不是有效的文件夹')
    const existing = getFolderByPath(folderPath)
    folderId = existing ? existing.id : addFolder(folderPath, path.basename(folderPath))
    broadcastScan({ phase: 'start', folderId })
    let added = 0
    let updated = 0
    let unsupported = 0
    const now = Date.now()

    // 1. 收集全部图片文件路径，同时统计已知不支持的格式（如 HEIC）用于明确提示
    const files: string[] = []
    for await (const file of walk(folderPath, () => unsupported++, token)) files.push(file)
    const found = files.length

    // 2. 并发 stat 后在内存中 diff
    const known = new Map<string, { id: number; mtime: number; size: number; missing: number }>()
    for (const r of listPhotoRowsByFolder(folderId)) {
      known.set(r.path.toLowerCase(), r)
    }
    const stats = await statAll(
      files,
      8,
      (processed) => {
        broadcastScan({ phase: 'progress', folderId, processed })
      },
      token
    )

    // 取消：此时尚未写库，直接以取消态返回，不留半成品索引
    if (token.cancelled) {
      broadcastScan({
        phase: 'done',
        folderId,
        found,
        added: 0,
        updated: 0,
        unsupported,
        cancelled: true
      })
      return { folderId, found, added: 0, updated: 0, unsupported, cancelled: true }
    }

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
    // added 以实际入库为准：批量插入对并发冲突（含大小写变体）幂等忽略，可能少于预插行数
    added = newIds.length
    updated = updates.length

    // 4. 统一入队缩略图生成
    for (const id of newIds) enqueueThumb(id)
    for (const u of updates) enqueueThumb(u.id)

    broadcastScan({ phase: 'done', folderId, found, added, updated, unsupported })
    broadcastLibraryChanged()
    return { folderId, found, added, updated, unsupported }
  } catch (err) {
    broadcastScan({
      phase: 'error',
      folderId,
      message: err instanceof Error ? err.message : String(err)
    })
    throw err
  } finally {
    activeScans.delete(token)
  }
}

/** 批量重命名等操作期间按路径抑制监听事件（unlink/add 会在改名后异步到达） */
const suppressedPaths = new Set<string>()
let suppressTimer: ReturnType<typeof setTimeout> | null = null

export function suppressTracking(paths: string[]): void {
  for (const p of paths) suppressedPaths.add(p.toLowerCase())
  if (suppressTimer) clearTimeout(suppressTimer)
  suppressTimer = setTimeout(() => suppressedPaths.clear(), 15000)
}

function isSuppressed(p: string): boolean {
  return suppressedPaths.has(p.toLowerCase())
}

/** 单文件新增（来自文件监听） */
export function trackNewFile(folderId: number, filePath: string): void {
  if (isSuppressed(filePath)) return
  // 回收站中的照片文件重新出现（用户从系统回收站放回等）：自动还原
  const deletedId = findDeletedPhotoId(filePath)
  if (deletedId !== null) {
    restorePhotos([deletedId])
    broadcastWatch({ type: 'add', folderId })
    return
  }
  const existing = findPhotoByPath(filePath)
  if (existing) {
    // 大小写不敏感命中：仅改大小写的重命名会走到这里，把索引刷新为磁盘上的
    // 实际大小写（文件名变化同时经 updatePhotoPath 重算搜索文本）；
    // 缺失标记的恢复语义不在本函数处理
    if (existing.path !== filePath) {
      updatePhotoPath(existing.id, filePath, path.basename(filePath))
    }
    return
  }
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
  if (isSuppressed(filePath)) return
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
  if (isSuppressed(filePath)) return
  const row = findPhotoByPath(filePath)
  if (!row) return
  updatePhotoFileFields(row.id, { missing: 1 })
  broadcastWatch({ type: 'unlink', folderId, id: row.id })
}
