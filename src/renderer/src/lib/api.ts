import type {
  AlbumInfo,
  AppInfo,
  DeleteResult,
  EditSpec,
  ExifData,
  ExportOptions,
  FolderInfo,
  ImportResult,
  LibraryStats,
  PhotoQuery,
  PhotoRecord,
  QueryResult,
  TagInfo,
  ThemeMode
} from '@shared/types'

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>
type On = (channel: string, cb: (data: unknown) => void) => () => void

declare global {
  interface Window {
    framora: { invoke: Invoke; on: On }
  }
}

const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  window.framora.invoke(channel, ...args) as Promise<T>

export const api = {
  info: (): Promise<AppInfo> => call('app:info'),
  getSetting: (key: string): Promise<string | null> => call('settings:get', key),
  pickFolder: (): Promise<string | null> => call('dialog:pickFolder'),
  pickExportDir: (): Promise<string | null> => call('dialog:pickExportDir'),

  listFolders: (): Promise<FolderInfo[]> => call('library:listFolders'),
  importFolder: (p: string): Promise<ImportResult> => call('library:importFolder', p),
  rescan: (id: number): Promise<ImportResult> => call('library:rescan', id),
  removeFolder: (id: number): Promise<{ removed: number }> => call('library:removeFolder', id),
  stats: (): Promise<LibraryStats> => call('library:stats'),

  queryPhotos: (q: PhotoQuery): Promise<QueryResult> => call('photos:query', q),
  getPhoto: (id: number): Promise<PhotoRecord> => call('photos:get', id),
  updateMeta: (
    id: number,
    patch: Partial<{ rating: number; title: string | null; description: string | null }>
  ): Promise<PhotoRecord> => call('photos:updateMeta', id, patch),
  metadata: (id: number): Promise<ExifData> => call('photos:metadata', id),
  deletePhotos: (ids: number[]): Promise<DeleteResult> => call('photos:delete', ids),
  exportPhotos: (
    ids: number[],
    dir: string,
    opts: ExportOptions
  ): Promise<{ exported: number; failed: number }> => call('photos:export', ids, dir, opts),
  saveEdits: (id: number, edit: EditSpec): Promise<PhotoRecord> => call('photos:saveEdits', id, edit),
  revertEdits: (id: number): Promise<PhotoRecord> => call('photos:revert', id),
  openInExplorer: (id: number): Promise<void> => call('photos:openInExplorer', id),
  regenerateThumb: (id: number): Promise<void> => call('photos:regenerateThumb', id),
  rebuildThumbs: (): Promise<void> => call('thumbs:rebuildAll'),

  setTags: (photoId: number, tagIds: number[]): Promise<void> =>
    call('photos:setTags', photoId, tagIds),
  batchTags: (ids: number[], add: number[], remove: number[]): Promise<void> =>
    call('photos:batchTags', ids, add, remove),
  batchRate: (ids: number[], rating: number): Promise<void> => call('photos:batchRate', ids, rating),
  batchAlbum: (ids: number[], albumId: number | null): Promise<void> =>
    call('photos:batchAlbum', ids, albumId),
  removeAlbum: (photoId: number, albumId: number): Promise<void> =>
    call('photos:removeAlbum', photoId, albumId),

  listTags: (): Promise<TagInfo[]> => call('tags:list'),
  createTag: (name: string, color: string | null): Promise<TagInfo> =>
    call('tags:create', name, color),
  renameTag: (id: number, name: string): Promise<void> => call('tags:rename', id, name),
  deleteTag: (id: number): Promise<void> => call('tags:delete', id),

  listAlbums: (): Promise<AlbumInfo[]> => call('albums:list'),
  createAlbum: (name: string, color: string | null): Promise<number> =>
    call('albums:create', name, color),
  renameAlbum: (id: number, name: string): Promise<void> => call('albums:rename', id, name),
  deleteAlbum: (id: number): Promise<void> => call('albums:delete', id),

  setTheme: (mode: ThemeMode): Promise<void> => call('window:setTheme', mode),
  openDataDir: (): Promise<void> => call('app:openDataDir'),
  openThumbsDir: (): Promise<void> => call('app:openThumbsDir'),
  clearBackups: (): Promise<number> => call('app:clearBackups')
}

export type EventChannel = 'evt:scan' | 'evt:thumb' | 'evt:watch' | 'evt:library'
export const onEvent = (channel: EventChannel, cb: (data: never) => void): (() => void) =>
  window.framora.on(channel, cb as (data: unknown) => void)
