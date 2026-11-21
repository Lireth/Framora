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

export type PhotoScope =
  | 'all'
  | 'recent'
  | 'missing'
  | 'folder'
  | 'album'
  | 'tag'
  | 'untagged'
  | 'smart'
  | 'duplicates'
  | 'trash'

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

export interface CropRect {
  /** 归一化裁剪区域（相对当前视觉画面，0..1） */
  x: number
  y: number
  w: number
  h: number
}

export interface EditSpec {
  rotateDelta?: number
  flipH?: boolean
  flipV?: boolean
  brightness?: number
  contrast?: number
  saturation?: number
  /** 色温：正=暖，负=冷 */
  temperature?: number
  /** 色调：正=品红，负=偏绿 */
  tint?: number
  /** 锐化强度 0..100 */
  sharpen?: number
  /** 裁剪（归一化，应用在旋转/翻转后的视觉空间） */
  crop?: CropRect
}

export interface ExportOptions {
  maxSide?: number
  quality?: number
  format?: 'original' | 'jpeg' | 'webp' | 'png' | 'avif'
  /** 文件名模板，支持 {name} 原文件名、{date} 拍摄日期、{index} 三位序号 */
  nameTemplate?: string
}

export interface SmartAlbumInfo {
  id: number
  name: string
  color: string | null
  created_at: number
}

/** 智能相册保存的筛选条件 */
export interface SmartAlbumQuery {
  keyword?: string
  dateFrom?: string
  dateTo?: string
  minRating?: number
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
  /** 回收站中的照片数（软删除） */
  trash: number
}

export interface ScanEvent {
  phase: 'start' | 'progress' | 'done' | 'error'
  folderId: number
  found?: number
  added?: number
  updated?: number
  processed?: number
  /** 已识别但当前构建无法解码的格式数量（如 HEIC），用于导入完成提示 */
  unsupported?: number
  /** 本次扫描标记为缺失的数量（目录清单中已不存在的已知文件） */
  missing?: number
  /** 用户取消扫描（此时尚未写库，无半成品索引） */
  cancelled?: boolean
  message?: string
}

export interface ExportEvent {
  done: number
  total: number
}

export interface ExportResult {
  exported: number
  failed: number
  /** 用户取消导出（已完成部分保留） */
  cancelled?: boolean
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
  /** 已识别但当前构建无法解码的格式数量（如 HEIC） */
  unsupported?: number
  /** 本次扫描标记为缺失的数量（目录清单中已不存在的已知文件） */
  missing?: number
  /** 用户取消导入 */
  cancelled?: boolean
}

/** 单张照片的编辑备份条目（按时间倒序） */
export interface BackupInfo {
  name: string
  ts: number
  size: number
}

export interface ImportFilesResult {
  /** 资料库内直接入库的数量 */
  indexed: number
  /** 资料库外复制到目标文件夹后入库的数量 */
  copied: number
  /** 非图片 / 复制失败 / 取消目标选择而跳过的数量 */
  skipped: number
}

export interface AppInfo {
  version: string
  electron: string
  platform: string
}

/** 主题模式：system 跟随操作系统深浅色（渲染层经 prefers-color-scheme 解析） */
export type ThemeMode = 'dark' | 'light' | 'system'

/** 手动检查更新的结果 */
export interface UpdateCheckResult {
  /** dev：开发模式无更新配置；up-to-date：已是最新；available：有新版本；error：检查失败 */
  status: 'dev' | 'up-to-date' | 'available' | 'error'
  /** 新版本号（available 时） */
  version?: string
  error?: string
}

/** 更新流程事件（下载进度等） */
export interface UpdateEvent {
  phase: 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error'
  version?: string
  /** 下载进度 0-100 */
  percent?: number
  message?: string
}

/** 更新流程状态快照（主进程持有，供设置页重开时恢复） */
export interface UpdateState {
  phase: 'idle' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error'
  version?: string
  percent?: number
  message?: string
}

/** 可撤销的元数据删除类型：资料库文件夹 / 标签 / 相册 */
export type UndoKind = 'folder' | 'tag' | 'album'

/** 一次可撤销的元数据删除（软删除，恢复即清除 deleted_at） */
export interface UndoEntry {
  kind: UndoKind
  id: number
  /** 删除前的显示名，用于状态栏与提示文案 */
  label: string
  /** 受影响的可见照片数 */
  photos: number
  /** 操作时间戳（毫秒），用于旧条目排序与展示 */
  at: number
}

export const UNDO_KIND_LABEL: Record<UndoKind, string> = {
  folder: '文件夹',
  tag: '标签',
  album: '相册',
}
