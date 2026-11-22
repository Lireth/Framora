import path from 'node:path'
import fs from 'node:fs'
import exifr from 'exifr'
import sharp from 'sharp'
import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import * as db from './db'
import { IMAGE_EXTS, formatBytes, formatDateTime } from '@shared/formats'
import {
  broadcastLibraryChanged,
  cancelScan,
  importFolder,
  suppressTracking,
  splitImportPaths,
  trackNewFile,
  waitForScansIdle,
} from './scanner'
import {
  bumpThumbGeneration,
  cleanupOrphanThumbs,
  clearThumbQueue,
  enqueueThumb,
  previewPath,
  rebuildAllThumbs,
  thumbPath,
  thumbsDir,
} from './thumbs'
import { bumpPhashGeneration } from './phash'
import { reconcileWatchers, startWatcher, stopAllWatchers, stopWatcher } from './watcher'
import {
  applyTemplate,
  cancelExport,
  cleanupOrphanBackups,
  clearAllBackups,
  exportPhotos,
  listBackups,
  migrateLegacyEditBackups,
  pickName,
  rekeyEditBackups,
  removePhotoBackups,
  revertEdits,
  saveEdits,
} from './imageops'
import { bumpExifMetaGeneration, clearExifMetaQueue } from './exifmeta'
import { logsDir, logError } from './log'
import { listFolders } from './db'
import {
  cleanAllPreviews,
  enforceStorageBudgets,
  setStorageLimits,
  storageStats,
} from './storage'
import {
  cancelUpdateDownload,
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  installUpdate,
} from './updater'
import type {
  DeleteResult,
  EditSpec,
  ExportOptions,
  FolderInfo,
  MetaPair,
  PhotoQuery,
  SmartAlbumQuery,
  StorageLimits,
  ThemeMode,
} from '@shared/types'
import { UndoStore } from './undo'

/* ---------- 元数据删除撤销栈 ----------
 * 栈管理与持久化格式过滤在 ./undo（OPT-22 抽取，纯逻辑可单测），
 * 此处仅注入 settings 读写并把各类恢复动作接到 db。 */

const undoStore = new UndoStore({
  read: () => db.getSetting('undoStack'),
  write: (raw) => db.setSetting('undoStack', raw),
})

export function registerIpc(): void {
  // 旧版编辑备份（裸 id 命名）按当前库一次性重绑定到路径哈希命名（O3）
  migrateLegacyEditBackups()
  undoStore.load()

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
  }))

  /* ---------- settings ---------- */
  ipcMain.handle('settings:get', (_e, key: string) => db.getSetting(key))
  // 设置键白名单（OPT-32）：渲染层不可写任意键（预算/阈值等键有各自专用通道与校验）
  const SETTABLE_KEYS = new Set(['theme', 'viewState', 'searchHistory'])
  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    if (!SETTABLE_KEYS.has(key) || typeof value !== 'string') return
    db.setSetting(key, value)
  })

  /* ---------- storage（占用统计与预算清理） ---------- */
  ipcMain.handle('storage:stats', () => storageStats())
  ipcMain.handle('storage:setLimits', (_e, limits: StorageLimits) => setStorageLimits(limits))
  ipcMain.handle('storage:cleanPreviews', () => cleanAllPreviews())
  ipcMain.handle('storage:enforce', () => enforceStorageBudgets())

  /* ---------- dialogs ---------- */
  ipcMain.handle('dialog:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      title: '选择包含照片的文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:pickExportDir', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      title: '选择导出位置',
      properties: ['openDirectory', 'createDirectory'],
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:pickFiles', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      title: '选择要导入的照片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: [...IMAGE_EXTS] }],
    })
    return r.canceled ? null : r.filePaths
  })

  /* ---------- library ---------- */
  ipcMain.handle('library:listFolders', () => listFolders())

  ipcMain.handle('library:importFolder', async (_e, folderPath: string) => {
    // 新注册 / 待复活的文件夹先挂监听再扫描（OPT-17）：消除「扫描完成 → watcher
    // 启动」窗口内新建/删除事件的同步盲区（此窗口内新建的文件直到下次手动重扫
    // 才会被索引）。ignoreInitial 保证挂载本身不触发导入；扫描内部复用此处注册
    // 的文件夹行。已有正常文件夹无此盲区，维持扫描后挂载。
    const existing = db.getFolderByPath(folderPath)
    const fresh = existing === undefined || existing.deleted_at != null
    if (fresh && fs.existsSync(folderPath)) {
      const folderId = existing ? existing.id : db.addFolder(folderPath, path.basename(folderPath))
      await startWatcher(folderId, folderPath)
    }
    const result = await importFolder(folderPath)
    const folder = db.getFolderByPath(folderPath)
    if (folder) await startWatcher(folder.id, folder.path) // 已挂载时为幂等 no-op
    // 重新导入同一路径会复活已移除的文件夹，对应撤销条目已失去意义
    undoStore.drop('folder', result.folderId)
    return result
  })

  ipcMain.handle('library:importFiles', async (_e, filePaths: string[]) => {
    // 拖入/选择可能混合文件与文件夹：按真实类型分流（渲染层拿不到可靠的目录标记）
    const { dirs, files, skipped: classifySkipped } = await splitImportPaths(filePaths)
    let skipped = classifySkipped

    // 文件夹：已在资料库内的重扫所属根目录（不注册嵌套根）；库外则注册并监听。
    // 先处理文件夹，随后同批拖入的子文件会自然归入新资料库，不再弹目标目录选择。
    dirs.sort((a, b) => a.length - b.length)
    const acceptedDirs: string[] = []
    let folders = 0
    for (const dir of dirs) {
      const lower = dir.toLowerCase()
      // 同批拖入父子目录时只处理父级，避免重复扫描
      if (acceptedDirs.some((a) => lower === a || lower.startsWith(a + path.sep))) continue
      acceptedDirs.push(lower)
      try {
        const owner = findOwnerFolder(dir, listFolders())
        if (owner) {
          await importFolder(owner.path)
        } else {
          const res = await importFolder(dir)
          await startWatcher(res.folderId, dir)
        }
        folders++
      } catch (err) {
        logError('importFiles:folder', err)
        skipped++
      }
    }

    const foldersNow = listFolders()
    const internal: { folderId: number; path: string }[] = []
    const external: string[] = []
    for (const p of files) {
      const owner = findOwnerFolder(p, foldersNow)
      if (owner) internal.push({ folderId: owner.id, path: p })
      else external.push(p)
    }
    let copied = 0
    if (external.length) {
      const win = BrowserWindow.getFocusedWindow()
      const r = await dialog.showOpenDialog(win!, {
        title: '选择库外照片的导入目标文件夹',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (r.canceled) {
        skipped += external.length
      } else {
        const dest = r.filePaths[0]
        await fs.promises.mkdir(dest, { recursive: true })
        const used = new Set<string>()
        const copiedPaths: string[] = []
        for (const src of external) {
          try {
            const ext = path.extname(src).toLowerCase().slice(1)
            const base = path.basename(src, path.extname(src))
            const { outPath } = pickName(dest, base, ext, used)
            await fs.promises.copyFile(src, outPath)
            used.add(outPath.toLowerCase())
            copiedPaths.push(outPath)
          } catch (err) {
            logError('importFiles', err)
          }
        }
        copied = copiedPaths.length
        skipped += external.length - copied
        if (copiedPaths.length) {
          // 目标已在某资料库内则逐文件入库，避免把子目录注册成嵌套根；否则按新文件夹导入并监听
          const owner = findOwnerFolder(dest, listFolders())
          if (owner) {
            await Promise.all(copiedPaths.map((op) => trackNewFile(owner.id, op)))
          } else {
            const res = await importFolder(dest)
            await startWatcher(res.folderId, dest)
          }
        }
      }
    }
    // 等待全部入库完成再返回，渲染进程随后刷新即可看到新行；
    // 返回真正新增的数量（已索引/仅改名不计数）
    const added = await Promise.all(internal.map((f) => trackNewFile(f.folderId, f.path)))
    return { indexed: added.filter(Boolean).length, copied, skipped, folders }
  })

  ipcMain.handle('library:rescan', async (_e, folderId: number) => {
    const folders = listFolders()
    const folder = folders.find((f) => f.id === folderId)
    if (!folder) throw new Error('文件夹不存在')
    return importFolder(folder.path)
  })

  ipcMain.handle('library:cancelScan', () => cancelScan())

  ipcMain.handle('library:removeFolder', async (_e, folderId: number) => {
    await stopWatcher(folderId)
    // 软删除：照片行、标签/相册关系、缩略图全部保留，撤销时无需重建
    const info = db.softRemoveFolder(folderId)
    if (!info) return { removed: 0 }
    undoStore.push({ kind: 'folder', id: folderId, label: info.name, photos: info.photos })
    broadcastLibraryChanged()
    return { removed: info.photos }
  })

  ipcMain.handle('library:stats', () => db.libraryStats())
  ipcMain.handle('library:distribution', () => db.libraryDistribution())

  /** 导出索引库备份为单文件 */
  ipcMain.handle('library:exportBackup', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const defaultName = `framora-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.db`
    const r = await dialog.showSaveDialog(win!, {
      title: '导出索引库备份',
      defaultPath: defaultName,
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
    })
    if (r.canceled || !r.filePath) return null
    await db.exportBackup(r.filePath)
    return r.filePath
  })

  /** 用备份文件替换当前索引库，并重挂监听、补建缺失缩略图 */
  ipcMain.handle('library:importBackup', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      title: '选择索引库备份文件',
      properties: ['openFile'],
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
    })
    if (r.canceled || !r.filePaths[0]) return null
    // 换库前置闸门（OPT-16）：db.importBackup 会 closeDb → 文件替换 → 重开，
    // 在途扫描闭包持有的语句将指向已关闭/被移走的库文件（SQLITE_MISUSE 或 IO 错误），
    // 且取消令牌无法跨换库生效。先取消扫描并等待全部退出、清空缩略图待生成队列，
    // 再执行换库；导出任务只读已解析到内存的行且产物写库外，不受换库影响。
    cancelScan()
    await waitForScansIdle()
    clearThumbQueue()
    await db.importBackup(r.filePaths[0])
    // 换库后旧库实体 id 全部失效，撤销栈必须清空
    undoStore.clear()
    // 库代次递增：旧库在途的缩略图/感知哈希任务检测到代次变化即作废写入（O3）
    bumpThumbGeneration()
    bumpPhashGeneration()
    bumpExifMetaGeneration()
    clearExifMetaQueue()
    void db.markPhashDirty()
    // 旧库的 watcher 与新库 id 不对应，全部停掉后按新库对账重建
    await stopAllWatchers()
    await reconcileWatchers()
    // 清空全部按 id 命名的缩略图产物：旧库 id 与新库照片错位，immutable 缓存
    // 会把错位结果固化，必须全量重建而非仅补缺失
    const thumbs = thumbsDir()
    try {
      for (const name of fs.readdirSync(thumbs)) {
        fs.rmSync(path.join(thumbs, name), { force: true, recursive: true })
      }
    } catch {
      /* 目录尚不存在等 */
    }
    const ids = db.listAllPhotoIds()
    for (const id of ids) {
      db.setThumbStatus(id, 0)
      enqueueThumb(id)
    }
    return { photos: db.libraryStats().total, rebuiltThumbs: ids.length }
  })

  /** 重复治理：每组保留一张（最佳=体积最大，其次最早；最早=导入时间最早），选中其余冗余项 */
  ipcMain.handle('duplicates:selectRedundant', async (_e, mode: 'best' | 'oldest') => {
    const clusters = await db.duplicateClusters()
    const redundant: number[] = []
    for (const cluster of clusters) {
      const rows = cluster
        .map((id) => db.getPhotoRow(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
      if (rows.length < 2) continue
      const keeper = rows.reduce((a, b) => {
        // best：体积最大优先，其次最早导入；oldest：最早导入优先；并列取 id 小者
        if (mode === 'best' && b.size !== a.size) return b.size > a.size ? b : a
        if (b.imported_at !== a.imported_at) return b.imported_at < a.imported_at ? b : a
        return b.id < a.id ? b : a
      })
      for (const r of rows) if (r.id !== keeper.id) redundant.push(r.id)
    }
    return { ids: redundant, clusters: clusters.length }
  })

  /** 相似度阈值（汉明距离上限）：保存设置并置脏聚类缓存，下次查询按新阈值重算 */
  ipcMain.handle('duplicates:setThreshold', (_e, v: number) => {
    if (!Number.isFinite(v)) return db.phashThreshold()
    const clamped = Math.min(12, Math.max(2, Math.floor(v)))
    db.setSetting('phashThreshold', String(clamped))
    db.markPhashDirty()
    return clamped
  })

  /* ---------- photos ---------- */
  // 地点视图数据源（FEAT-07）
  ipcMain.handle('photos:geo', () => db.listGeoPhotos())

  ipcMain.handle('photos:query', (_e, q: PhotoQuery) =>
    q.scope === 'duplicates' ? db.queryDuplicates(q) : db.queryPhotos(q),
  )
  ipcMain.handle('photos:queryIds', (_e, q: PhotoQuery) =>
    q.scope === 'duplicates' ? db.duplicatePhotoIds() : db.queryPhotoIds(q),
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
      }>,
    ) => {
      db.updatePhotoMeta(id, patch)
      return db.getPhotoRecord(id)
    },
  )

  ipcMain.handle('photos:metadata', async (_e, id: number) => {
    const row = db.getPhotoRecord(id)
    if (!row) throw new Error('照片不存在')
    const pairs: MetaPair[] = [
      { label: '文件名', value: row.name },
      { label: '格式', value: row.ext.toUpperCase() },
      { label: '尺寸', value: row.width && row.height ? `${row.width} × ${row.height}` : '未知' },
      { label: '大小', value: formatBytes(row.size) },
      { label: '拍摄时间', value: row.taken_at ? formatDateTime(row.taken_at) : '未知' },
      { label: '导入时间', value: formatDateTime(row.imported_at) },
      { label: '路径', value: row.path },
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
          reviveValues: true,
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
    // 软删除：索引移入回收站视图，磁盘文件保留在原位置，可随时还原或彻底删除
    const n = db.softDeletePhotos(ids)
    broadcastLibraryChanged()
    return { deleted: n, failed: ids.length - n }
  })

  /** 彻底删除：磁盘文件移入系统回收站，索引行与缩略图一并清除（不可在应用内还原） */
  async function purgePhotoRows(rows: { id: number; path: string }[]): Promise<DeleteResult> {
    let failed = 0
    const okIds: number[] = []
    let cursor = 0
    const CONCURRENCY = 4
    const worker = async (): Promise<void> => {
      while (cursor < rows.length) {
        const row = rows[cursor++]
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
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(CONCURRENCY, rows.length)) }, worker),
    )
    db.deletePhotoRows(okIds)
    await Promise.all(
      okIds.flatMap((id) => [
        fs.promises.rm(thumbPath(id), { force: true }).catch(() => undefined),
        fs.promises.rm(previewPath(id), { force: true }).catch(() => undefined),
        // 编辑备份随照片彻底删除一并清理（OPT-21：否则 backups 只增不减且不可见）
        removePhotoBackups(id),
      ]),
    )
    broadcastLibraryChanged()
    return { deleted: okIds.length, failed }
  }

  ipcMain.handle('photos:restore', (_e, ids: number[]) => {
    const restored = db.restorePhotos(ids)
    broadcastLibraryChanged()
    return { restored }
  })

  ipcMain.handle('photos:purge', async (_e, ids: number[]) => {
    // 仅允许彻底删除已在回收站中的照片（安全过滤）
    return purgePhotoRows(await db.listDeletedRows(ids))
  })

  ipcMain.handle('photos:emptyTrash', async () => purgePhotoRows(db.listAllDeletedRows()))

  ipcMain.handle('photos:export', async (_e, ids: number[], destDir: string, opts: ExportOptions) =>
    exportPhotos(ids, destDir, opts),
  )

  ipcMain.handle('photos:cancelExport', () => cancelExport())

  ipcMain.handle('photos:saveEdits', async (_e, id: number, edit: EditSpec) => {
    await saveEdits(id, edit)
    return db.getPhotoRecord(id)
  })

  ipcMain.handle('photos:revert', async (_e, id: number, backupName?: string) => {
    await revertEdits(id, backupName)
    return db.getPhotoRecord(id)
  })

  ipcMain.handle('photos:listBackups', async (_e, id: number) => listBackups(id))

  ipcMain.handle('photos:openInExplorer', (_e, id: number) => {
    const row = db.getPhotoRow(id)
    if (!row) return
    shell.showItemInFolder(row.path)
  })

  // 在系统浏览器打开 OpenStreetMap 定位照片拍摄地点：渲染层只传坐标数值，
  // URL 在主进程构造，不拼入任意字符串
  ipcMain.handle('photos:openInMap', (_e, lat: number, lon: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return
    const url = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`
    void shell.openExternal(url)
  })

  ipcMain.handle('photos:regenerateThumb', (_e, id: number) => {
    db.setThumbStatus(id, 0)
    // 用户显式请求：以紧急优先级入队，不排在批量导入之后
    enqueueThumb(id, 'urgent')
  })

  ipcMain.handle('thumbs:rebuildAll', () => rebuildAllThumbs())

  ipcMain.handle('thumbs:cleanupOrphans', () => cleanupOrphanThumbs())

  ipcMain.handle('thumbs:clearQueue', () => clearThumbQueue())

  /* ---------- undo（元数据软删除撤销） ---------- */

  ipcMain.handle('undo:peek', () => undoStore.peek())

  ipcMain.handle('undo:perform', async () => {
    const entry = undoStore.peek()
    if (!entry) return null
    // 先恢复成功再出栈：恢复抛错时保留条目，用户可重试
    if (entry.kind === 'folder') {
      const folder = db.restoreFolder(entry.id)
      // 路径已不存在时仅恢复索引（照片会在下次扫描标记缺失），不重挂监听
      if (folder && fs.existsSync(folder.path)) await startWatcher(entry.id, folder.path)
    } else if (entry.kind === 'tag') {
      db.restoreTag(entry.id)
    } else if (entry.kind === 'album') {
      db.restoreAlbum(entry.id)
    } else {
      db.restoreSmartAlbum(entry.id)
    }
    undoStore.pop()
    broadcastLibraryChanged()
    return entry
  })

  /* ---------- tags ---------- */
  ipcMain.handle('tags:list', () => db.listTags())
  ipcMain.handle('tags:create', (_e, name: string, color: string | null) => {
    const tag = db.createTag(name.trim(), color)
    // 同名新建会复活软删除标签，旧撤销条目不再适用
    undoStore.drop('tag', tag.id)
    return tag
  })
  ipcMain.handle('tags:rename', (_e, id: number, name: string) => db.renameTag(id, name.trim()))
  ipcMain.handle('tags:setColor', (_e, id: number, color: string | null) =>
    db.setTagColor(id, color),
  )
  ipcMain.handle('tags:delete', (_e, id: number) => {
    const info = db.deleteTag(id)
    if (!info) throw new Error('标签不存在或已删除')
    undoStore.push({ kind: 'tag', id, label: info.name, photos: info.photos })
    broadcastLibraryChanged()
    return info
  })
  ipcMain.handle('photos:setTags', (_e, photoId: number, tagIds: number[]) =>
    db.setPhotoTags(photoId, tagIds),
  )

  ipcMain.handle(
    'photos:batchTags',
    (_e, ids: number[], addTagIds: number[], removeTagIds: number[]) =>
      db.batchTags(ids, addTagIds, removeTagIds),
  )

  ipcMain.handle('photos:batchRename', async (_e, ids: number[], template: string) => {
    let renamed = 0
    let skipped = 0
    let failed = 0
    const used = new Set<string>()
    for (let i = 0; i < ids.length; i++) {
      const row = db.getPhotoRow(ids[i])
      if (!row || row.missing || !fs.existsSync(row.path)) {
        failed++
        continue
      }
      try {
        const base = applyTemplate(template || '{name}', row, i)
        const ext = path.extname(row.path)
        const newName = `${base}${ext}`
        const newPath = path.join(path.dirname(row.path), newName)
        const same = newPath.toLowerCase() === row.path.toLowerCase()
        if (same) {
          skipped++
          continue
        }
        if (used.has(newPath.toLowerCase()) || fs.existsSync(newPath)) {
          skipped++
          continue
        }
        // 重命名的 unlink/add 监听事件异步到达（awaitWriteFinish 约 600ms），必须在
        // rename 之前逐对抑制：大批量超过该延迟后，循环结束才抑制会让早期事件
        // 先行触发——旧行误标缺失、新路径重复入库、随后撞唯一路径索引计 failed。
        // suppressTracking 为集合累加 + 15s 滑动清空，逐对调用使抑制窗口覆盖整批。
        suppressTracking([row.path, newPath])
        await fs.promises.rename(row.path, newPath)
        used.add(newPath.toLowerCase())
        db.updatePhotoPath(row.id, newPath, newName)
        // 路径哈希变化：编辑备份重绑定到新路径，历史保持可恢复（O3）
        rekeyEditBackups(row.id, newPath)
        renamed++
      } catch (err) {
        logError('batchRename', err)
        failed++
      }
    }
    return { renamed, skipped, failed }
  })
  ipcMain.handle('photos:batchRate', (_e, ids: number[], rating: number) =>
    db.batchRate(ids, rating),
  )
  ipcMain.handle('photos:batchAlbum', (_e, ids: number[], albumId: number | null) =>
    db.batchAlbum(ids, albumId),
  )
  ipcMain.handle('photos:removeAlbum', (_e, photoId: number, albumId: number) =>
    db.removeFromAlbum(photoId, albumId),
  )

  /* ---------- albums ---------- */
  ipcMain.handle('albums:list', () => db.listAlbums())
  ipcMain.handle('albums:create', (_e, name: string, color: string | null) =>
    db.createAlbum(name.trim(), color),
  )
  ipcMain.handle('albums:rename', (_e, id: number, name: string) => db.renameAlbum(id, name.trim()))
  ipcMain.handle('albums:setColor', (_e, id: number, color: string | null) =>
    db.setAlbumColor(id, color),
  )
  ipcMain.handle('albums:delete', (_e, id: number) => {
    const info = db.deleteAlbum(id)
    if (!info) throw new Error('相册不存在或已删除')
    undoStore.push({ kind: 'album', id, label: info.name, photos: info.photos })
    broadcastLibraryChanged()
    return info
  })

  /* ---------- smart albums ---------- */
  ipcMain.handle('smartAlbums:list', () => db.listSmartAlbums())
  ipcMain.handle('smartAlbums:create', (_e, name: string, query: SmartAlbumQuery) =>
    db.createSmartAlbum(name.trim(), query),
  )
  ipcMain.handle('smartAlbums:rename', (_e, id: number, name: string) =>
    db.renameSmartAlbum(id, name.trim()),
  )
  ipcMain.handle(
    'smartAlbums:update',
    (_e, id: number, name: string, query: SmartAlbumQuery) =>
      db.updateSmartAlbum(id, name.trim(), query),
  )
  ipcMain.handle('smartAlbums:delete', (_e, id: number) => {
    // 软删除（FEAT-13）：与普通相册一致纳入撤销栈
    const info = db.deleteSmartAlbum(id)
    if (!info) return null
    undoStore.push({ kind: 'smart', id, label: info.name, photos: info.photos })
    return info
  })

  /* ---------- window / theme ---------- */
  ipcMain.handle('window:setTheme', (_e, mode: ThemeMode) => {
    if (mode !== 'dark' && mode !== 'light' && mode !== 'system') return
    db.setSetting('theme', mode)
  })

  ipcMain.handle('window:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })

  ipcMain.handle('window:maximizeToggle', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.handle('window:isMaximized', (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
  })

  ipcMain.handle('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
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

  // 清理无主编辑备份（照片行已不存在的 id 组）：删除照片/换库遗留，backups 可收敛
  ipcMain.handle('app:cleanupOrphanBackups', () => cleanupOrphanBackups())

  ipcMain.handle('app:openLogsDir', () => {
    shell.openPath(logsDir())
  })

  ipcMain.handle('app:dragOutPhotos', async (_e, ids: number[]) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || !ids.length) return
    // 解析全部有效行：文件已不存在的项跳过（多选拖出允许部分成功）
    const rows = ids.flatMap((id) => {
      const row = db.getPhotoRow(id)
      return row && fs.existsSync(row.path) ? [row] : []
    })
    if (!rows.length) return
    // 生成 48px 拖拽图标（优先用首张缩略图），随后启动原生 OS 拖拽；
    // 文件名带时间戳避免连续拖拽互相覆盖，超过 1 分钟的旧图标顺手清理
    const userData = app.getPath('userData')
    for (const f of fs.readdirSync(userData)) {
      const m = /^drag-icon-(\d+)\.png$/.exec(f)
      if (m && Date.now() - Number(m[1]) > 60_000) {
        fs.rmSync(path.join(userData, f), { force: true })
      }
    }
    const iconPath = path.join(userData, `drag-icon-${Date.now()}.png`)
    try {
      const src = fs.existsSync(thumbPath(rows[0].id)) ? thumbPath(rows[0].id) : rows[0].path
      await sharp(src, { failOn: 'none' })
        .rotate()
        .resize(48, 48, { fit: 'inside' })
        .png()
        .toFile(iconPath)
    } catch {
      // 打包产物不含 build/ 目录（files 仅打包 out/**），应用图标兜底会缺失；
      // 合成占位图标，保证拖拽手势不会静默失效
      await sharp({ create: { width: 48, height: 48, channels: 3, background: '#e0b36a' } })
        .png()
        .toFile(iconPath)
        .catch(() => undefined)
      if (!fs.existsSync(iconPath)) return
    }
    win.webContents.startDrag({
      file: rows[0].path,
      files: rows.map((r) => r.path),
      icon: iconPath,
    })
  })

  /* ---------- update（手动检查，隐私优先） ---------- */
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:cancelDownload', () => cancelUpdateDownload())
  ipcMain.handle('update:install', () => installUpdate())
  ipcMain.handle('update:getState', () => getUpdateState())
}

/* ---------- helpers ---------- */

/** 找到包含该路径的资料库根文件夹（最长前缀匹配，Windows 路径大小写不敏感） */
function findOwnerFolder(filePath: string, folders: FolderInfo[]): FolderInfo | null {
  const rp = path.resolve(filePath).toLowerCase()
  let best: FolderInfo | null = null
  let bestLen = -1
  for (const f of folders) {
    const r = path.resolve(f.path).toLowerCase()
    const prefix = r.endsWith(path.sep) ? r : r + path.sep
    if ((rp === r || rp.startsWith(prefix)) && r.length > bestLen) {
      best = f
      bestLen = r.length
    }
  }
  return best
}

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
