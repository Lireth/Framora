import { create } from 'zustand'
import { api } from './lib/api'
import type {
  AlbumInfo,
  FolderInfo,
  LibraryStats,
  PhotoLite,
  PhotoQuery,
  PhotoScope,
  SmartAlbumInfo,
  TagInfo,
  ThemeMode,
  UndoEntry,
} from '@shared/types'
import { UNDO_KIND_LABEL } from '@shared/types'

export interface Toast {
  id: number
  type: 'info' | 'success' | 'error'
  text: string
}

export interface ScanState {
  active: boolean
  label: string
}

export type SortKey = 'taken' | 'imported' | 'name' | 'rating' | 'size'

export interface Filters {
  scope: PhotoScope
  scopeId: number | undefined
  keyword: string
  dateFrom: string
  dateTo: string
  minRating: number
  sort: SortKey
  dir: 'asc' | 'desc'
}

interface AppState extends Filters {
  theme: ThemeMode
  /** 实际生效主题：theme=system 时跟随 OS 深浅色解析 */
  resolvedTheme: 'dark' | 'light'
  folders: FolderInfo[]
  tags: TagInfo[]
  albums: AlbumInfo[]
  smartAlbums: SmartAlbumInfo[]
  stats: LibraryStats
  photos: PhotoLite[]
  total: number
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  lastQueryKey: string | null
  /** 待生成缩略图数（照片替换时重算一次，状态栏只订阅该数字） */
  pendingThumbCount: number
  selection: Set<number>
  anchorId: number | null
  activeId: number | null
  viewerOpen: boolean
  detailOpen: boolean
  tile: 's' | 'm' | 'l'
  gridCols: number
  navTick: number
  searchHistory: string[]
  scan: ScanState
  exportProgress: { done: number; total: number } | null
  toasts: Toast[]
  settingsOpen: boolean
  exportOpen: boolean
  exportIds: number[] | null
  confirmDeleteOpen: boolean
  helpOpen: boolean
  /** 当前原生拖拽携带的照片 id 与路径（瓦片/查看器拖出会话），at 为发起时间戳供新鲜度校验 */
  draggingPhotos: { ids: number[]; paths: string[]; at: number } | null
  appVersion: string
  /** 最近一次可撤销的元数据删除（文件夹/标签/相册） */
  undoEntry: UndoEntry | null

  init: () => Promise<void>
  setTheme: (mode: ThemeMode) => void
  setScope: (scope: PhotoScope, scopeId?: number) => void
  setFilter: (patch: Partial<Filters>) => void
  refreshLibrary: () => Promise<void>
  refreshPhotos: () => Promise<void>
  loadMorePhotos: () => Promise<void>
  refreshUndo: () => Promise<void>
  performUndo: () => Promise<void>
  toggleSelect: (id: number, opts?: { additive?: boolean; range?: boolean }) => void
  selectAll: () => Promise<void>
  setSelection: (ids: number[]) => void
  clearSelection: () => void
  openViewer: (id: number) => void
  closeViewer: () => void
  setActive: (id: number) => void
  stepViewer: (delta: number) => void
  jumpViewer: (target: 'first' | 'last') => Promise<void>
  toggleDetail: () => void
  setTile: (t: 's' | 'm' | 'l') => void
  setGridCols: (n: number) => void
  navigateGrid: (dx: number, dy: number) => void
  recordSearch: (term: string) => void
  clearSearchHistory: () => void
  setScan: (s: ScanState) => void
  setExportProgress: (p: { done: number; total: number } | null) => void
  toast: (type: Toast['type'], text: string) => void
  dismissToast: (id: number) => void
  setSettingsOpen: (v: boolean) => void
  openExport: (ids: number[] | null) => void
  closeExport: () => void
  setConfirmDeleteOpen: (v: boolean) => void
  setHelpOpen: (v: boolean) => void
  setDraggingPhotos: (ids: number[] | null, paths?: string[]) => void
  applyThumbEvents: (list: { id: number; status: 'ok' | 'fail' }[]) => void
  patchPhoto: (id: number, patch: Partial<PhotoLite> & { mtime?: number }) => void
  /** 批量同补丁更新（单次遍历）：网格快捷键批量评分等场景，避免逐张 patch 的 O(n·k) */
  patchPhotos: (ids: number[], patch: Partial<PhotoLite> & { mtime?: number }) => void
}

let toastSeq = 1
let refreshLibraryTimer: ReturnType<typeof setTimeout> | null = null
let refreshPhotosTimer: ReturnType<typeof setTimeout> | null = null
let viewStateTimer: ReturnType<typeof setTimeout> | null = null
let thumbBuffer: { id: number; status: 'ok' | 'fail' }[] = []
let thumbTimer: ReturnType<typeof setTimeout> | null = null
/** 缩略图事件早于照片列表到达时的暂存（导入期间列表尚未刷新）；列表加载时按 id 合并 */
const pendingThumb = new Map<number, 'ok' | 'fail'>()

function mergePendingThumb(items: PhotoLite[]): PhotoLite[] {
  if (!pendingThumb.size) return items
  const now = Date.now()
  let touched = false
  const out = items.map((p) => {
    const st = pendingThumb.get(p.id)
    if (!st) return p
    pendingThumb.delete(p.id)
    touched = true
    return {
      ...p,
      thumb_status: (st === 'ok' ? 1 : 2) as 0 | 1 | 2,
      thumb_ts: now
    }
  })
  return touched ? out : items
}

/** 防抖持久化视图状态（scope/tile/sort/dir），启动时恢复 */
function persistViewState(): void {
  if (viewStateTimer) clearTimeout(viewStateTimer)
  viewStateTimer = setTimeout(() => {
    viewStateTimer = null
    const s = useStore.getState()
    void api
      .setSetting(
        'viewState',
        JSON.stringify({
          scope: s.scope,
          scopeId: s.scopeId ?? null,
          tile: s.tile,
          sort: s.sort,
          dir: s.dir,
        }),
      )
      .catch(() => undefined)
  }, 400)
}

const VALID_SCOPES: PhotoScope[] = [
  'all',
  'recent',
  'missing',
  'folder',
  'album',
  'tag',
  'untagged',
  'smart',
  'duplicates',
  'trash',
]
const VALID_TILES = ['s', 'm', 'l'] as const
const VALID_SORTS: SortKey[] = ['taken', 'imported', 'name', 'rating', 'size']

/** 分页加载数量：首屏与每次增量加载 */
const PAGE_SIZE = 500

/** photos 数组的 id→下标映射：按数组引用 WeakMap 缓存，每次数组替换只重建一次，
 *  键盘导航/翻图/范围选择等高频路径 O(1) 定位（此前每次按键 findIndex 全量扫描） */
const photoIndexCache = new WeakMap<PhotoLite[], Map<number, number>>()
export function photoIndexOf(photos: PhotoLite[], id: number | null): number {
  if (id === null) return -1
  let m = photoIndexCache.get(photos)
  if (!m) {
    m = new Map()
    for (let i = 0; i < photos.length; i++) m.set(photos[i].id, i)
    photoIndexCache.set(photos, m)
  }
  return m.get(id) ?? -1
}

/** 待生成缩略图计数（与状态栏口径一致：thumb_status===0 且未缺失） */
function countPendingThumbs(photos: PhotoLite[]): number {
  let n = 0
  for (const p of photos) if (p.thumb_status === 0 && !p.missing) n++
  return n
}

/** 系统深浅色媒体查询：theme=system 时的解析依据 */
const systemDarkMq =
  typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

/** 由用户选择模式解析实际生效主题 */
function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  return mode === 'system' ? (systemDarkMq?.matches ? 'dark' : 'light') : mode
}

function buildQuery(s: AppState): PhotoQuery {
  return {
    scope: s.scope,
    scopeId: s.scopeId,
    keyword: s.keyword.trim() || undefined,
    dateFrom: s.dateFrom || undefined,
    dateTo: s.dateTo || undefined,
    minRating: s.minRating || undefined,
    sort: s.sort,
    dir: s.dir,
  }
}

export const useStore = create<AppState>((set, get) => ({
  theme: 'dark',
  resolvedTheme: 'dark',
  scope: 'all',
  scopeId: undefined,
  keyword: '',
  dateFrom: '',
  dateTo: '',
  minRating: 0,
  sort: 'taken',
  dir: 'desc',
  folders: [],
  tags: [],
  albums: [],
  smartAlbums: [],
  stats: { total: 0, missing: 0, untagged: 0, trash: 0 },
  photos: [],
  total: 0,
  loading: false,
  loadingMore: false,
  hasMore: false,
  lastQueryKey: null,
  pendingThumbCount: 0,
  selection: new Set(),
  anchorId: null,
  activeId: null,
  viewerOpen: false,
  detailOpen: false,
  tile: 'm',
  gridCols: 6,
  navTick: 0,
  searchHistory: [],
  scan: { active: false, label: '' },
  exportProgress: null,
  toasts: [],
  settingsOpen: false,
  exportOpen: false,
  exportIds: null,
  confirmDeleteOpen: false,
  helpOpen: false,
  draggingPhotos: null,
  appVersion: '',
  undoEntry: null,

  init: async () => {
    try {
      const saved = await api.getSetting('theme')
      const theme: ThemeMode =
        saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'dark'
      set({ theme, resolvedTheme: resolveTheme(theme) })
      // 同步镜像到 localStorage：preload 在首帧前读取，消除浅色/系统用户的启动闪变
      try {
        localStorage.setItem('framora-theme', theme)
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
    // 跟随系统主题：OS 深浅色切换时仅 system 模式需要重新解析
    systemDarkMq?.addEventListener?.('change', () => {
      const s = get()
      if (s.theme === 'system') set({ resolvedTheme: resolveTheme('system') })
    })
    // 恢复上次的视图状态与搜索历史
    try {
      const rawHistory = await api.getSetting('searchHistory')
      if (rawHistory) {
        const list = JSON.parse(rawHistory) as unknown
        if (Array.isArray(list)) {
          set({
            searchHistory: list.filter((x): x is string => typeof x === 'string').slice(0, 10),
          })
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const raw = await api.getSetting('viewState')
      if (raw) {
        const v = JSON.parse(raw) as Partial<{
          scope: PhotoScope
          scopeId: number | null
          tile: 's' | 'm' | 'l'
          sort: SortKey
          dir: 'asc' | 'desc'
        }>
        const scope = VALID_SCOPES.includes(v.scope as PhotoScope) ? (v.scope as PhotoScope) : 'all'
        const needsId =
          scope === 'folder' || scope === 'album' || scope === 'tag' || scope === 'smart'
        set({
          scope,
          scopeId: needsId && typeof v.scopeId === 'number' ? v.scopeId : undefined,
          tile: VALID_TILES.includes(v.tile as 's' | 'm' | 'l') ? (v.tile as 's' | 'm' | 'l') : 'm',
          sort: VALID_SORTS.includes(v.sort as SortKey) ? (v.sort as SortKey) : 'taken',
          dir: v.dir === 'asc' ? 'asc' : 'desc',
        })
      }
    } catch {
      /* ignore */
    }
    await get().refreshLibrary()
    await get().refreshUndo()
    // 校验作用域指向的文件夹/相册/标签是否仍存在，失效则回退到全部照片
    const st = get()
    const scopeGone =
      (st.scope === 'folder' && !st.folders.some((f) => f.id === st.scopeId)) ||
      (st.scope === 'album' && !st.albums.some((a) => a.id === st.scopeId)) ||
      (st.scope === 'tag' && !st.tags.some((t) => t.id === st.scopeId)) ||
      (st.scope === 'smart' && !st.smartAlbums.some((a) => a.id === st.scopeId))
    if (scopeGone) set({ scope: 'all', scopeId: undefined })
    get().refreshPhotos()
    api
      .info()
      .then((i) => set({ appVersion: i.version }))
      .catch(() => undefined)
  },

  setTheme: (mode) => {
    set({ theme: mode, resolvedTheme: resolveTheme(mode) })
    // localStorage 镜像供 preload 首帧使用（ipc 侧同时持久化到索引库）
    try {
      localStorage.setItem('framora-theme', mode)
    } catch {
      /* ignore */
    }
    api.setTheme(mode).catch(() => undefined)
  },

  setScope: (scope, scopeId) => {
    if (get().scope === scope && get().scopeId === scopeId) return
    set({ scope, scopeId, selection: new Set(), anchorId: null })
    get().refreshPhotos()
    persistViewState()
  },

  setFilter: (patch) => {
    set(patch as Partial<AppState>)
    get().refreshPhotos()
    persistViewState()
  },

  refreshLibrary: async () => {
    try {
      const [folders, tags, albums, smartAlbums, stats] = await Promise.all([
        api.listFolders(),
        api.listTags(),
        api.listAlbums(),
        api.listSmartAlbums(),
        api.stats(),
      ])
      set({ folders, tags, albums, smartAlbums, stats })
    } catch {
      /* ignore */
    }
  },

  /** 同步主进程撤销栈顶条目（跨重启保留） */
  refreshUndo: async () => {
    try {
      set({ undoEntry: await api.peekUndo() })
    } catch {
      set({ undoEntry: null })
    }
  },

  /** 撤销最近一次文件夹/标签/相册删除 */
  performUndo: async () => {
    try {
      const entry = await api.performUndo()
      if (!entry) {
        set({ undoEntry: null })
        get().toast('info', '没有可撤销的操作')
        return
      }
      set({ undoEntry: await api.peekUndo() })
      get().toast(
        'success',
        `已恢复${UNDO_KIND_LABEL[entry.kind]}「${entry.label}」（${entry.photos} 张照片）`,
      )
      await get().refreshLibrary()
      await get().refreshPhotos()
    } catch (err) {
      get().toast('error', `撤销失败：${err instanceof Error ? err.message : String(err)}`)
    }
  },

  refreshPhotos: async () => {
    const snapshot = buildQuery(get())
    const queryKey = JSON.stringify(snapshot)
    const queryChanged = queryKey !== get().lastQueryKey
    set({ loading: true })
    try {
      const r = await api.queryPhotos({ ...snapshot, limit: PAGE_SIZE })
      if (JSON.stringify(buildQuery(get())) !== JSON.stringify(snapshot)) {
        return // 过滤条件已变化，丢弃过期结果
      }
      const items = mergePendingThumb(r.items)
      // 仅在过滤条件变化时按已加载结果裁剪选择集，后台数据刷新不破坏既有选择
      const selection = queryChanged
        ? (() => {
            const valid = new Set(items.map((p) => p.id))
            return new Set([...get().selection].filter((id) => valid.has(id)))
          })()
        : get().selection
      set({
        photos: items,
        total: r.total,
        hasMore: items.length < r.total,
        loading: false,
        selection,
        pendingThumbCount: countPendingThumbs(items),
        lastQueryKey: queryKey,
      })
    } catch (err) {
      set({ loading: false })
      get().toast('error', `照片查询失败：${err instanceof Error ? err.message : String(err)}`)
    }
  },

  /** 增量加载下一页（滚动/翻图接近已加载末尾时触发） */
  loadMorePhotos: async () => {
    const { loading, loadingMore, hasMore, photos } = get()
    if (loading || loadingMore || !hasMore) return
    const snapshot = buildQuery(get())
    set({ loadingMore: true })
    try {
      const r = await api.queryPhotos({ ...snapshot, limit: PAGE_SIZE, offset: photos.length })
      if (JSON.stringify(buildQuery(get())) !== JSON.stringify(snapshot)) {
        set({ loadingMore: false })
        return
      }
      const loaded = new Set(photos.map((p) => p.id))
      const fresh = mergePendingThumb(r.items).filter((p) => !loaded.has(p.id))
      const merged = [...photos, ...fresh]
      set({
        photos: merged,
        total: r.total,
        hasMore: merged.length < r.total,
        loadingMore: false,
        pendingThumbCount: countPendingThumbs(merged),
      })
    } catch (err) {
      set({ loadingMore: false })
      get().toast('error', `加载更多失败：${err instanceof Error ? err.message : String(err)}`)
    }
  },

  toggleSelect: (id, opts) => {
    const { photos, selection, anchorId } = get()
    const next = new Set(selection)
    if (opts?.range && anchorId !== null) {
      const a = photoIndexOf(photos, anchorId)
      const b = photoIndexOf(photos, id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        for (let i = lo; i <= hi; i++) next.add(photos[i].id)
      }
    } else if (opts?.additive) {
      if (next.has(id)) next.delete(id)
      else next.add(id)
      set({ anchorId: id })
    } else {
      next.clear()
      next.add(id)
      set({ anchorId: id })
    }
    set({ selection: next })
  },

  /** 全选当前查询条件下的全部照片（不受分页加载范围限制） */
  selectAll: async () => {
    const q = buildQuery(get())
    try {
      const ids = await api.queryPhotoIds(q)
      set({ selection: new Set(ids), anchorId: null, lastQueryKey: JSON.stringify(q) })
    } catch (err) {
      // 查询失败保持原选择，但需让用户可见
      get().toast('error', `全选失败：${err instanceof Error ? err.message : String(err)}`)
    }
  },

  setSelection: (ids) => set({ selection: new Set(ids), anchorId: null }),

  clearSelection: () => set({ selection: new Set(), anchorId: null }),

  openViewer: (id) => set({ activeId: id, viewerOpen: true }),

  closeViewer: () => set({ viewerOpen: false, activeId: get().activeId }),

  setActive: (id) => set({ activeId: id }),

  stepViewer: (delta) => {
    const { photos, activeId } = get()
    if (!photos.length) return
    const idx = photoIndexOf(photos, activeId)
    const next = idx < 0 ? 0 : Math.min(photos.length - 1, Math.max(0, idx + delta))
    set({ activeId: photos[next].id })
    // 接近已加载末尾时预取下一页，保证连续翻图
    if (next >= photos.length - 30) void get().loadMorePhotos()
  },

  /** 查看器跳转：first 定位首张；last 反向取 1 条定位末张（串行补页仅在 dir 不被
   *  主进程尊重的作用域下回退使用，避免特大库按 End 连续数十次分页请求） */
  jumpViewer: async (target) => {
    if (!get().photos.length) return
    if (target === 'first') {
      set({ activeId: get().photos[0].id })
      return
    }
    const fallback = async (): Promise<void> => {
      let guard = 0
      while (get().hasMore && guard < 400) {
        await get().loadMorePhotos()
        guard++
      }
      const photos = get().photos
      if (photos.length) set({ activeId: photos[photos.length - 1].id })
    }
    const q = buildQuery(get())
    // recent/trash/duplicates 的排序由主进程固定（dir 被忽略），反向查询取不到末张
    if (q.scope === 'recent' || q.scope === 'trash' || q.scope === 'duplicates') {
      await fallback()
      return
    }
    try {
      const r = await api.queryPhotos({ ...q, dir: q.dir === 'desc' ? 'asc' : 'desc', limit: 1 })
      if (r.items.length) set({ activeId: r.items[0].id })
      else await fallback()
    } catch {
      await fallback()
    }
  },

  toggleDetail: () => set({ detailOpen: !get().detailOpen }),

  setTile: (tile) => {
    set({ tile })
    persistViewState()
  },

  setGridCols: (n) => {
    if (get().gridCols !== n) set({ gridCols: n })
  },

  /** 网格方向键导航：dx/dy 为位移量，移动后单选目标项并触发滚动定位 */
  navigateGrid: (dx, dy) => {
    const { photos, anchorId, gridCols, navTick } = get()
    if (!photos.length) return
    const idx = photoIndexOf(photos, anchorId)
    if (idx < 0) {
      set({ anchorId: photos[0].id, selection: new Set([photos[0].id]), navTick: navTick + 1 })
      return
    }
    const next = Math.min(photos.length - 1, Math.max(0, idx + dx + dy * Math.max(1, gridCols)))
    if (next === idx) return
    const id = photos[next].id
    set({ anchorId: id, selection: new Set([id]), navTick: navTick + 1 })
  },

  /** 记录搜索历史（去重、最多 10 条、持久化） */
  recordSearch: (term) => {
    const t = term.trim()
    if (!t) return
    const next = [t, ...get().searchHistory.filter((x) => x !== t)].slice(0, 10)
    set({ searchHistory: next })
    void api.setSetting('searchHistory', JSON.stringify(next)).catch(() => undefined)
  },

  clearSearchHistory: () => {
    set({ searchHistory: [] })
    void api.setSetting('searchHistory', '[]').catch(() => undefined)
  },

  setScan: (scan) => set({ scan }),

  setExportProgress: (p) => set({ exportProgress: p }),

  toast: (type, text) => {
    const id = toastSeq++
    set({ toasts: [...get().toasts, { id, type, text }] })
    setTimeout(() => get().dismissToast(id), 4000)
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  setSettingsOpen: (v) => set({ settingsOpen: v }),

  openExport: (ids) => set({ exportOpen: true, exportIds: ids }),

  closeExport: () => set({ exportOpen: false, exportIds: null }),

  setConfirmDeleteOpen: (v) => set({ confirmDeleteOpen: v }),

  setHelpOpen: (v) => set({ helpOpen: v }),

  setDraggingPhotos: (ids, paths) => {
    if (!ids || !ids.length) {
      set({ draggingPhotos: null })
      return
    }
    // 记录拖出文件的绝对路径：窗口级 drop 据此区分「应用内照片拖拽」与「资源管理器拖入」
    const byId = new Map(get().photos.map((p) => [p.id, p.path]))
    const known = paths ?? ids.flatMap((id) => {
      const p = byId.get(id)
      return p ? [p] : []
    })
    set({ draggingPhotos: { ids, paths: known, at: Date.now() } })
  },

  applyThumbEvents: (list) => {
    thumbBuffer.push(...list)
    if (thumbTimer !== null) return
    // 不用 rAF 合批：窗口被遮挡/最小化时 Chromium 会暂停帧回调，
    // 缩略图事件会一直积压，网格停在骨架屏
    thumbTimer = setTimeout(() => {
      thumbTimer = null
      const updates = thumbBuffer
      thumbBuffer = []
      if (!updates.length) return
      const map = new Map(updates.map((u) => [u.id, u.status]))
      const now = Date.now()
      const photos = get().photos
      // 事件可能早于列表到达：先全部暂存，下方命中当前视图的条目会从暂存中删除，
      // 剩余即「列表尚未包含」的事件，待 refreshPhotos / loadMorePhotos 按 id 合并
      // （免去每批构建 O(n) known 集合）
      for (const u of updates) pendingThumb.set(u.id, u.status)
      if (pendingThumb.size > 5000) pendingThumb.clear()
      let touched = false
      const next = photos.map((p) => {
        const st = map.get(p.id)
        if (!st) return p
        pendingThumb.delete(p.id)
        touched = true
        return {
          ...p,
          thumb_status: (st === 'ok' ? 1 : 2) as 0 | 1 | 2,
          thumb_ts: now,
        }
      })
      if (touched) set({ photos: next, pendingThumbCount: countPendingThumbs(next) })
    }, 32)
  },

  patchPhoto: (id, patch) => {
    const photos = get().photos.map((p) => (p.id === id ? { ...p, ...patch } : p))
    set({ photos, pendingThumbCount: countPendingThumbs(photos) })
  },

  patchPhotos: (ids, patch) => {
    if (!ids.length) return
    const targets = new Set(ids)
    const photos = get().photos.map((p) => (targets.has(p.id) ? { ...p, ...patch } : p))
    set({ photos, pendingThumbCount: countPendingThumbs(photos) })
  },
}))

/** 供事件流使用的防抖刷新 */
export function scheduleLibraryRefresh(delay = 400): void {
  if (refreshLibraryTimer) clearTimeout(refreshLibraryTimer)
  refreshLibraryTimer = setTimeout(() => {
    refreshLibraryTimer = null
    useStore.getState().refreshLibrary()
  }, delay)
}

export function schedulePhotosRefresh(delay = 400): void {
  if (refreshPhotosTimer) clearTimeout(refreshPhotosTimer)
  refreshPhotosTimer = setTimeout(() => {
    refreshPhotosTimer = null
    useStore.getState().refreshPhotos()
  }, delay)
}

/** 缩略图事件提交（32ms setTimeout 合批，原因见 applyThumbEvents 内注释） */
export function pushThumbEvent(list: { id: number; status: 'ok' | 'fail' }[]): void {
  useStore.getState().applyThumbEvents(list)
}
