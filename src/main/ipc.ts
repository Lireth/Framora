import path from 'node:path'
import fs from 'node:fs'
import exifr from 'exifr'
import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import * as db from './db'
import { importFolder } from './scanner'
import { enqueueThumb, rebuildAllThumbs, thumbPath, thumbsDir } from './thumbs'
import { startWatcher, stopWatcher } from './watcher'
import { clearAllBackups, exportPhotos, revertEdits, saveEdits } from './imageops'
import { listFolders } from './db'
import type {
  EditSpec,
  ExportOptions,
  MetaPair,
  PhotoQuery,
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
  ipcMain.handle('photos:query', (_e, q: PhotoQuery) => db.queryPhotos(q))
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
        pushPair(pairs, '相机制造商', d.Make)
        pushPair(pairs, '相机型号', d.Model)
        pushPair(pairs, '镜头', d.LensModel ?? d.LensMake)
        pushPair(pairs, 'ISO', d.ISO)
        pushPair(pairs, '光圈', d.FNumber ? `f/${d.FNumber}` : undefined)
        pushPair(pairs, '快门', d.ExposureTime ? formatShutter(d.ExposureTime) : undefined)
        pushPair(pairs, '焦距', d.FocalLength ? `${Math.round(d.FocalLength)}mm` : undefined)
        pushPair(pairs, '曝光补偿', d.ExposureCompensation)
        pushPair(pairs, '白平衡', d.WhiteBalance)
        pushPair(pairs, '闪光灯', d.Flash)
        pushPair(pairs, '软件', d.Software)
        if (typeof d.latitude === 'number' && typeof d.longitude === 'number') {
          pushPair(pairs, 'GPS', `${d.latitude.toFixed(5)}, ${d.longitude.toFixed(5)}`)
        }
      }
    } catch {
      /* exif 不可用时仅显示文件信息 */
    }
    return { pairs }
  })

  ipcMain.handle('photos:delete', async (_e, ids: number[]) => {
    let deleted = 0
    let failed = 0
    for (const id of ids) {
      const row = db.getPhotoRow(id)
      if (!row) {
        failed++
        continue
      }
      try {
        if (fs.existsSync(row.path)) {
          await shell.trashItem(row.path)
        }
        await fs.promises.rm(thumbPath(id), { force: true }).catch(() => undefined)
        db.deletePhotoRows([id])
        deleted++
      } catch {
        failed++
      }
    }
    return { deleted, failed }
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

  /* ---------- tags ---------- */
  ipcMain.handle('tags:list', () => db.listTags())
  ipcMain.handle('tags:create', (_e, name: string, color: string | null) =>
    db.createTag(name.trim(), color)
  )
  ipcMain.handle('tags:rename', (_e, id: number, name: string) => db.renameTag(id, name.trim()))
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
  ipcMain.handle('albums:delete', (_e, id: number) => db.deleteAlbum(id))

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
}

/* ---------- helpers ---------- */

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
