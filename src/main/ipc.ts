import path from 'node:path'
import fs from 'node:fs'
import exifr from 'exifr'
import sharp from 'sharp'
import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import * as db from './db'
import { importFolder } from './scanner'
import { cleanupOrphanThumbs, enqueueThumb, rebuildAllThumbs, thumbPath, thumbsDir } from './thumbs'
import { startWatcher, stopWatcher } from './watcher'
import { clearAllBackups, exportPhotos, revertEdits, saveEdits } from './imageops'
import { logsDir } from './log'
import { listFolders } from './db'
import type {
  EditSpec,
  ExportOptions,
  MetaPair,
  PhotoQuery,
  SmartAlbumQuery,
  ThemeMode
} from '@shared/types'

export function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform
  }))

  /* ---------- settings ---------- */
  ipcMain.handle('settings:get', (_e, key: string) => db.getSetting(key))
  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    db.setSetting(key, value)
  })

  /* ---------- dialogs ---------- */
  ipcMain.handle('dialog:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      title: '选择包含照片的文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:pickExportDir', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      title: '选择导出位置',
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled ? null : r.filePaths[0]
  })

  /* ---------- library ---------- */
  ipcMain.handle('library:listFolders', () => listFolders())

  ipcMain.handle('library:importFolder', async (_e, folderPath: string) => {
    const result = await importFolder(folderPath)
    const folder = db.getFolderByPath(folderPath)
    if (folder) await startWatcher(folder.id, folder.path)
    return result
  })

  ipcMain.handle('library:rescan', async (_e, folderId: number) => {
    const folders = listFolders()
    const folder = folders.find((f) => f.id === folderId)
    if (!folder) throw new Error('文件夹不存在')
    return importFolder(folder.path)
  })

  ipcMain.handle('library:removeFolder', async (_e, folderId: number) => {
    await stopWatcher(folderId)
    const rows = db.removeFolderRows(folderId)
    for (const r of rows) {
      fs.promises.rm(thumbPath(r.id), { force: true }).catch(() => undefined)
    }
    return { removed: rows.length }
  })

  ipcMain.handle('library:stats', () => db.libraryStats())

  /* ---------- photos ---------- */
  ipcMain.handle('photos:query', (_e, q: PhotoQuery) =>
    q.scope === 'duplicates' ? db.queryDuplicates(q) : db.queryPhotos(q)
  )
  ipcMain.handle('photos:queryIds', (_e, q: PhotoQuery) =>
    q.scope === 'duplicates' ? db.duplicatePhotoIds() : db.queryPhotoIds(q)
  )
  ipcMain.handle('photos:get', (_e, id: number) => db.getPhotoRecord(id))

  ipcMain.handle(
    'photos:updateMeta',
    (
      _e,
      id: number,
      patch: Partial<{
        rating: number
        title: string | null
        description: string | null
        orientation: number
      }>
    ) => {
      db.updatePhotoMeta(id, patch)
      return db.getPhotoRecord(id)
    }
  )

  ipcMain.handle('photos:metadata', async (_e, id: number) => {
    const row = db.getPhotoRecord(id)
    if (!row) throw new Error('照片不存在')
    const pairs: MetaPair[] = [
      { label: '文件名', value: row.name },
      { label: '格式', value: row.ext.toUpperCase() },
      { label: '尺寸', value: row.width && row.height ? `${row.width} × ${row.height}` : '未知' },
      { label: '大小', value: formatSize(row.size) },
      { label: '拍摄时间', value: row.taken_at ? formatDate(row.taken_at) : '未知' },
      { label: '导入时间', value: formatDate(row.imported_at) },
      { label: '路径', value: row.path }
    ]
    let src = row.path
    if (!fs.existsSync(src)) {
      const backup = await findLatestBackup(id)
      if (backup) src = backup
    }
    // EXIF 解析按 源文件+mtime 缓存，避免重复查看时反复解析大文件
    const cacheKey = `${src}|${row.mtime}`
    const cached = exifCacheGet(cacheKey)
    if (cached) {
      pairs.push(...cached)
    } else {
      const exifPairs: MetaPair[] = []
      try {
        const d = await exifr.parse(src, {
          tiff: true,
          exif: true,
          gps: true,
          xmp: false,
          icc: false,
          iptc: false,
          translateValues: true,
          reviveValues: true
        })
        if (d) {
          pushPair(exifPairs, '相机制造商', d.Make)
          pushPair(exifPairs, '相机型号', d.Model)
          pushPair(exifPairs, '镜头', d.LensModel ?? d.LensMake)
          pushPair(exifPairs, 'ISO', d.ISO)
          pushPair(exifPairs, '光圈', d.FNumber ? `f/${d.FNumber}` : undefined)
          pushPair(exifPairs, '快门', d.ExposureTime ? formatShutter(d.ExposureTime) : undefined)
          pushPair(exifPairs, '焦距', d.FocalLength ? `${Math.round(d.FocalLength)}mm` : undefined)
          pushPair(exifPairs, '曝光补偿', d.ExposureCompensation)
          pushPair(exifPairs, '白平衡', d.WhiteBalance)
          pushPair(exifPairs, '闪光灯', d.Flash)
          pushPair(exifPairs, '软件', d.Software)
          if (typeof d.latitude === 'number' && typeof d.longitude === 'number') {
            pushPair(exifPairs, 'GPS', `${d.latitude.toFixed(5)}, ${d.longitude.toFixed(5)}`)
          }
        }
      } catch {
        /* exif 不可用时仅显示文件信息 */
      }
      exifCachePut(cacheKey, exifPairs)
      pairs.push(...exifPairs)
    }
    return { pairs }
  })

  ipcMain.handle('photos:delete', async (_e, ids: number[]) => {
    let failed = 0
    // 索引中不存在的直接计为失败
    const trashing = db.getPhotoRows(ids)
    failed += ids.length - trashing.length
    // 回收站操作限并发并行执行
    const okIds: number[] = []
    let cursor = 0
    const CONCURRENCY = 4
    const worker = async (): Promise<void> => {
      while (cursor < trashing.length) {
        const row = trashing[cursor++]
        try {
          if (fs.existsSync(row.path)) {
            await shell.trashItem(row.path)
          }
          okIds.push(row.id)
        } catch {
          failed++
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, trashing.length)) }, worker))
    // 单事务批量清理索引行
    db.deletePhotoRows(okIds)
    // 并行清理缩略图文件
    await Promise.all(
      okIds.map((id) => fs.promises.rm(thumbPath(id), { force: true }).catch(() => undefined))
    )
    return { deleted: okIds.length, failed }
  })

  ipcMain.handle(
    'photos:export',
    async (_e, ids: number[], destDir: string, opts: ExportOptions) =>
      exportPhotos(ids, destDir, opts)
  )

  ipcMain.handle('photos:saveEdits', async (_e, id: number, edit: EditSpec) => {
    await saveEdits(id, edit)
    return db.getPhotoRecord(id)
  })

  ipcMain.handle('photos:revert', async (_e, id: number) => {
    await revertEdits(id)
    return db.getPhotoRecord(id)
  })

  ipcMain.handle('photos:openInExplorer', (_e, id: number) => {
    const row = db.getPhotoRow(id)
    if (!row) return
    shell.showItemInFolder(row.path)
  })

  ipcMain.handle('photos:regenerateThumb', (_e, id: number) => {
    db.setThumbStatus(id, 0)
    enqueueThumb(id)
  })

  ipcMain.handle('thumbs:rebuildAll', () => rebuildAllThumbs())

  ipcMain.handle('thumbs:cleanupOrphans', () => cleanupOrphanThumbs())

  /* ---------- tags ---------- */
  ipcMain.handle('tags:list', () => db.listTags())
  ipcMain.handle('tags:create', (_e, name: string, color: string | null) =>
    db.createTag(name.trim(), color)
  )
  ipcMain.handle('tags:rename', (_e, id: number, name: string) => db.renameTag(id, name.trim()))
  ipcMain.handle('tags:setColor', (_e, id: number, color: string | null) => db.setTagColor(id, color))
  ipcMain.handle('tags:delete', (_e, id: number) => db.deleteTag(id))
  ipcMain.handle('photos:setTags', (_e, photoId: number, tagIds: number[]) =>
    db.setPhotoTags(photoId, tagIds)
  )

  ipcMain.handle(
    'photos:batchTags',
    (_e, ids: number[], addTagIds: number[], removeTagIds: number[]) =>
      db.batchTags(ids, addTagIds, removeTagIds)
  )
  ipcMain.handle('photos:batchRate', (_e, ids: number[], rating: number) =>
    db.batchRate(ids, rating)
  )
  ipcMain.handle('photos:batchAlbum', (_e, ids: number[], albumId: number | null) =>
    db.batchAlbum(ids, albumId)
  )
  ipcMain.handle('photos:removeAlbum', (_e, photoId: number, albumId: number) =>
    db.removeFromAlbum(photoId, albumId)
  )

  /* ---------- albums ---------- */
  ipcMain.handle('albums:list', () => db.listAlbums())
  ipcMain.handle('albums:create', (_e, name: string, color: string | null) =>
    db.createAlbum(name.trim(), color)
  )
  ipcMain.handle('albums:rename', (_e, id: number, name: string) => db.renameAlbum(id, name.trim()))
  ipcMain.handle('albums:setColor', (_e, id: number, color: string | null) =>
    db.setAlbumColor(id, color)
  )
  ipcMain.handle('albums:delete', (_e, id: number) => db.deleteAlbum(id))

  /* ---------- smart albums ---------- */
  ipcMain.handle('smartAlbums:list', () => db.listSmartAlbums())
  ipcMain.handle('smartAlbums:create', (_e, name: string, query: SmartAlbumQuery) =>
    db.createSmartAlbum(name.trim(), query)
  )
  ipcMain.handle('smartAlbums:rename', (_e, id: number, name: string) =>
    db.renameSmartAlbum(id, name.trim())
  )
  ipcMain.handle('smartAlbums:delete', (_e, id: number) => db.deleteSmartAlbum(id))

  /* ---------- window / theme ---------- */
  ipcMain.handle('window:setTheme', (_e, mode: ThemeMode) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && process.platform === 'win32') {
      try {
        win.setTitleBarOverlay(
          mode === 'dark'
            ? { color: '#101014', symbolColor: '#e7e8ea' }
            : { color: '#f4f5f7', symbolColor: '#3a3f4b' }
        )
      } catch {
        /* win10 老版本可能不支持 */
      }
    }
    db.setSetting('theme', mode)
  })

  ipcMain.handle('window:toggleFullscreen', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setFullScreen(!win.isFullScreen())
  })

  ipcMain.handle('app:openDataDir', () => {
    shell.openPath(app.getPath('userData'))
  })

  ipcMain.handle('app:openThumbsDir', () => {
    shell.openPath(thumbsDir())
  })

  ipcMain.handle('app:clearBackups', () => clearAllBackups())

  ipcMain.handle('app:openLogsDir', () => {
    shell.openPath(logsDir())
  })

  ipcMain.handle('app:dragOutPhotos', async (_e, ids: number[]) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || !ids.length) return
    const row = db.getPhotoRow(ids[0])
    if (!row || !fs.existsSync(row.path)) return
    // 生成 48px 拖拽图标（优先用缩略图），随后启动原生 OS 拖拽
    const iconPath = path.join(app.getPath('userData'), 'drag-icon.png')
    let icon = iconPath
    try {
      const src = fs.existsSync(thumbPath(row.id)) ? thumbPath(row.id) : row.path
      await sharp(src, { failOn: 'none' }).rotate().resize(48, 48, { fit: 'inside' }).png().toFile(iconPath)
    } catch {
      icon = path.join(app.getAppPath(), 'build', 'icon.png')
      if (!fs.existsSync(icon)) return
    }
    win.webContents.startDrag({ file: row.path, files: [row.path], icon })
  })
}

/* ---------- helpers ---------- */

/** EXIF 解析结果 LRU 缓存（键 path|mtime，重复查看同一照片免重复解析大文件） */
const EXIF_CACHE_MAX = 200
const exifCache = new Map<string, MetaPair[]>()

function exifCacheGet(key: string): MetaPair[] | undefined {
  const hit = exifCache.get(key)
  if (hit !== undefined) {
    // LRU：命中后移到最新位置
    exifCache.delete(key)
    exifCache.set(key, hit)
  }
  return hit
}

function exifCachePut(key: string, pairs: MetaPair[]): void {
  exifCache.set(key, pairs)
  if (exifCache.size > EXIF_CACHE_MAX) {
    const oldest = exifCache.keys().next().value
    if (oldest !== undefined) exifCache.delete(oldest)
  }
}

function pushPair(pairs: MetaPair[], label: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return
  pairs.push({ label, value: String(value) })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function formatShutter(sec: number): string {
  if (sec >= 1) return `${sec}s`
  return `1/${Math.round(1 / sec)}s`
}

async function findLatestBackup(id: number): Promise<string | null> {
  const dir = path.join(app.getPath('userData'), 'backups')
  try {
    const names = (await fs.promises.readdir(dir)).filter((n) => n.startsWith(`${id}-`))
    if (!names.length) return null
    names.sort((a, b) => b.localeCompare(a))
    return path.join(dir, names[0])
  } catch {
    return null
  }
}
