import type {
  AlbumInfo,
  AppInfo,
  BackupInfo,
  CleanupResult,
  DeleteResult,
  EditSpec,
  ExifData,
  ExportOptions,
  ExportResult,
  FolderInfo,
  ImportFilesResult,
  ImportResult,
  LibraryStats,
  PhotoQuery,
  PhotoRecord,
  UpdateCheckResult,
  UpdateState,
  QueryResult,
  SmartAlbumInfo,
  SmartAlbumQuery,
  StorageEnforceResult,
  StorageLimits,
  StorageStats,
  TagInfo,
  ThemeMode,
  UndoEntry,
} from '@shared/types'

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>
type On = (channel: string, cb: (data: unknown) => void) => () => void

declare global {
  interface Window {
    framora: {
      invoke: Invoke
      on: On
      /** 拖入文件/文件夹的绝对路径；无法解析时为空串 */
      getPathForFile: (file: File) => string
    }
  }
}

const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  window.framora.invoke(channel, ...args) as Promise<T>

export const api = {
  info: (): Promise<AppInfo> => call('app:info'),
  getSetting: (key: string): Promise<string | null> => call('settings:get', key),
  setSetting: (key: string, value: string): Promise<void> => call('settings:set', key, value),
  getStorageStats: (): Promise<StorageStats> => call('storage:stats'),
  setStorageLimits: (limits: StorageLimits): Promise<StorageLimits> =>
    call('storage:setLimits', limits),
  cleanPreviews: (): Promise<CleanupResult> => call('storage:cleanPreviews'),
  enforceStorage: (): Promise<StorageEnforceResult> => call('storage:enforce'),
  pickFolder: (): Promise<string | null> => call('dialog:pickFolder'),
  pickFiles: (): Promise<string[] | null> => call('dialog:pickFiles'),
  pickExportDir: (): Promise<string | null> => call('dialog:pickExportDir'),

  listFolders: (): Promise<FolderInfo[]> => call('library:listFolders'),
  importFolder: (p: string): Promise<ImportResult> => call('library:importFolder', p),
  importFiles: (paths: string[]): Promise<ImportFilesResult> => call('library:importFiles', paths),
  rescan: (id: number): Promise<ImportResult> => call('library:rescan', id),
  cancelScan: (): Promise<void> => call('library:cancelScan'),
  removeFolder: (id: number): Promise<{ removed: number }> => call('library:removeFolder', id),
  stats: (): Promise<LibraryStats> => call('library:stats'),
  exportBackup: (): Promise<string | null> => call('library:exportBackup'),
  importBackup: (): Promise<{ photos: number; rebuiltThumbs: number } | null> =>
    call('library:importBackup'),
  peekUndo: (): Promise<UndoEntry | null> => call('undo:peek'),
  performUndo: (): Promise<UndoEntry | null> => call('undo:perform'),
  selectRedundant: (mode: 'best' | 'oldest'): Promise<{ ids: number[]; clusters: number }> =>
    call('duplicates:selectRedundant', mode),

  queryPhotos: (q: PhotoQuery): Promise<QueryResult> => call('photos:query', q),
  queryPhotoIds: (q: PhotoQuery): Promise<number[]> => call('photos:queryIds', q),
  getPhoto: (id: number): Promise<PhotoRecord> => call('photos:get', id),
  updateMeta: (
    id: number,
    patch: Partial<{ rating: number; title: string | null; description: string | null }>,
  ): Promise<PhotoRecord> => call('photos:updateMeta', id, patch),
  metadata: (id: number): Promise<ExifData> => call('photos:metadata', id),
  deletePhotos: (ids: number[]): Promise<DeleteResult> => call('photos:delete', ids),
  restorePhotos: (ids: number[]): Promise<{ restored: number }> => call('photos:restore', ids),
  purgePhotos: (ids: number[]): Promise<DeleteResult> => call('photos:purge', ids),
  emptyTrash: (): Promise<DeleteResult> => call('photos:emptyTrash'),
  exportPhotos: (ids: number[], dir: string, opts: ExportOptions): Promise<ExportResult> =>
    call('photos:export', ids, dir, opts),
  cancelExport: (): Promise<void> => call('photos:cancelExport'),
  saveEdits: (id: number, edit: EditSpec): Promise<PhotoRecord> =>
    call('photos:saveEdits', id, edit),
  revertEdits: (id: number, backupName?: string): Promise<PhotoRecord> =>
    call('photos:revert', id, backupName),
  listBackups: (id: number): Promise<BackupInfo[]> => call('photos:listBackups', id),
  openInExplorer: (id: number): Promise<void> => call('photos:openInExplorer', id),
  regenerateThumb: (id: number): Promise<void> => call('photos:regenerateThumb', id),
  rebuildThumbs: (): Promise<void> => call('thumbs:rebuildAll'),
  cleanupOrphanThumbs: (): Promise<number> => call('thumbs:cleanupOrphans'),
  clearThumbQueue: (): Promise<number> => call('thumbs:clearQueue'),

  setTags: (photoId: number, tagIds: number[]): Promise<void> =>
    call('photos:setTags', photoId, tagIds),
  batchTags: (ids: number[], add: number[], remove: number[]): Promise<void> =>
    call('photos:batchTags', ids, add, remove),
  batchRate: (ids: number[], rating: number): Promise<void> =>
    call('photos:batchRate', ids, rating),
  batchAlbum: (ids: number[], albumId: number | null): Promise<void> =>
    call('photos:batchAlbum', ids, albumId),
  batchRename: (
    ids: number[],
    template: string,
  ): Promise<{ renamed: number; skipped: number; failed: number }> =>
    call('photos:batchRename', ids, template),
  removeAlbum: (photoId: number, albumId: number): Promise<void> =>
    call('photos:removeAlbum', photoId, albumId),

  listTags: (): Promise<TagInfo[]> => call('tags:list'),
  createTag: (name: string, color: string | null): Promise<TagInfo> =>
    call('tags:create', name, color),
  renameTag: (id: number, name: string): Promise<void> => call('tags:rename', id, name),
  setTagColor: (id: number, color: string | null): Promise<void> =>
    call('tags:setColor', id, color),
  deleteTag: (id: number): Promise<{ name: string; photos: number }> => call('tags:delete', id),

  listAlbums: (): Promise<AlbumInfo[]> => call('albums:list'),
  createAlbum: (name: string, color: string | null): Promise<number> =>
    call('albums:create', name, color),
  renameAlbum: (id: number, name: string): Promise<void> => call('albums:rename', id, name),
  setAlbumColor: (id: number, color: string | null): Promise<void> =>
    call('albums:setColor', id, color),
  deleteAlbum: (id: number): Promise<{ name: string; photos: number }> => call('albums:delete', id),

  listSmartAlbums: (): Promise<SmartAlbumInfo[]> => call('smartAlbums:list'),
  createSmartAlbum: (name: string, query: SmartAlbumQuery): Promise<number> =>
    call('smartAlbums:create', name, query),
  renameSmartAlbum: (id: number, name: string): Promise<void> =>
    call('smartAlbums:rename', id, name),
  updateSmartAlbum: (id: number, name: string, query: SmartAlbumQuery): Promise<void> =>
    call('smartAlbums:update', id, name, query),
  deleteSmartAlbum: (id: number): Promise<void> => call('smartAlbums:delete', id),

  setTheme: (mode: ThemeMode): Promise<void> => call('window:setTheme', mode),
  minimizeWindow: (): Promise<void> => call('window:minimize'),
  toggleMaximize: (): Promise<void> => call('window:maximizeToggle'),
  isMaximized: (): Promise<boolean> => call('window:isMaximized'),
  closeWindow: (): Promise<void> => call('window:close'),
  toggleFullscreen: (): Promise<void> => call('window:toggleFullscreen'),
  openDataDir: (): Promise<void> => call('app:openDataDir'),
  openThumbsDir: (): Promise<void> => call('app:openThumbsDir'),
  clearBackups: (): Promise<number> => call('app:clearBackups'),
  openLogsDir: (): Promise<void> => call('app:openLogsDir'),
  dragOutPhotos: (ids: number[]): Promise<void> => call('app:dragOutPhotos', ids),

  checkForUpdate: (): Promise<UpdateCheckResult> => call('update:check'),
  downloadUpdate: (): Promise<void> => call('update:download'),
  cancelUpdateDownload: (): Promise<void> => call('update:cancelDownload'),
  installUpdate: (): Promise<void> => call('update:install'),
  getUpdateState: (): Promise<UpdateState> => call('update:getState'),
}

export type EventChannel =
  | 'evt:scan'
  | 'evt:thumb'
  | 'evt:watch'
  | 'evt:library'
  | 'evt:export'
  | 'evt:update'
  | 'evt:maximize'
export const onEvent = (channel: EventChannel, cb: (data: never) => void): (() => void) =>
  window.framora.on(channel, cb as (data: unknown) => void)
