export interface FolderInfo {
  id: number
  path: string
  name: string
  count: number
  added_at: number
}

export interface PhotoLite {
  id: number
  path: string
  name: string
  ext: string
  size: number
  folder_id: number
  rating: number
  width: number | null
  height: number | null
  taken_at: number | null
  imported_at: number
  thumb_status: 0 | 1 | 2
  thumb_ts: number
  missing: 0 | 1
  orientation: number
}

export interface TagRef {
  id: number
  name: string
}

export interface PhotoRecord extends PhotoLite {
  title: string | null
  description: string | null
  mtime: number
  tags: TagRef[]
  albums: TagRef[]
}

export interface TagInfo {
  id: number
  name: string
  color: string | null
  count: number
}

export interface AlbumInfo {
  id: number
  name: string
  color: string | null
  count: number
  created_at: number
  /** 相册封面照片 id（相册内第一张照片，空相册为 undefined） */
  cover_id?: number | null
}

export type PhotoScope = 'all' | 'recent' | 'missing' | 'folder' | 'album' | 'tag' | 'untagged'

export interface PhotoQuery {
  scope: PhotoScope
  scopeId?: number
  keyword?: string
  dateFrom?: string
  dateTo?: string
  minRating?: number
  sort?: 'taken' | 'imported' | 'name' | 'rating' | 'size'
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface QueryResult {
  items: PhotoLite[]
  total: number
}

export interface EditSpec {
  rotateDelta?: number
  flipH?: boolean
  flipV?: boolean
  brightness?: number
  contrast?: number
  saturation?: number
}

export interface ExportOptions {
  maxSide?: number
  quality?: number
  format?: 'original' | 'jpeg' | 'webp' | 'png' | 'avif'
  /** 文件名模板，支持 {name} 原文件名、{date} 拍摄日期、{index} 三位序号 */
  nameTemplate?: string
}

export interface MetaPair {
  label: string
  value: string
}

export interface ExifData {
  pairs: MetaPair[]
}

export interface LibraryStats {
  total: number
  missing: number
  untagged: number
}

export interface ScanEvent {
  phase: 'start' | 'progress' | 'done' | 'error'
  folderId: number
  found?: number
  added?: number
  updated?: number
  processed?: number
  message?: string
}

export interface ExportEvent {
  done: number
  total: number
}

export interface ThumbEvent {
  id: number
  status: 'ok' | 'fail'
}

export interface WatchEvent {
  type: 'add' | 'change' | 'unlink'
  photo?: PhotoLite
  id?: number
  folderId: number
}

export interface DeleteResult {
  deleted: number
  failed: number
}

export interface ImportResult {
  folderId: number
  added: number
  updated: number
  found: number
}

export interface AppInfo {
  version: string
  electron: string
  platform: string
}

export type ThemeMode = 'dark' | 'light'
