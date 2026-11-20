import { create } from 'zustand'
import { api } from './lib/api'
import type {
  AlbumInfo,
  FolderInfo,
  LibraryStats,
  PhotoLite,
  PhotoQuery,
  PhotoScope,
  TagInfo,
  ThemeMode
} from '@shared/types'

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
  folders: FolderInfo[]
  tags: TagInfo[]
  albums: AlbumInfo[]
  stats: LibraryStats
  photos: PhotoLite[]
  total: number
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  lastQueryKey: string | null
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
  appVersion: string

  init: () => Promise<void>
  setTheme: (mode: ThemeMode) => void
  setScope: (scope: PhotoScope, scopeId?: number) => void
  setFilter: (patch: Partial<Filters>) => void
  refreshLibrary: () => Promise<void>
  refreshPhotos: () => Promise<void>
  loadMorePhotos: () => Promise<void>
  toggleSelect: (id: number, opts?: { additive?: boolean; range?: boolean }) => void
  selectAll: () => Promise<void>
  clearSelection: () => void
  openViewer: (id: number) => void
  closeViewer: () => void
  setActive: (id: number) => void
  stepViewer: (delta: number) => void
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
  applyThumbEvents: (list: { id: number; status: 'ok' | 'fail' }[]) => void
  patchPhoto: (id: number, patch: Partial<PhotoLite> & { mtime?: number }) => void
}

let toastSeq = 1
let refreshLibraryTimer: ReturnType<typeof setTimeout> | null = null
let refreshPhotosTimer: ReturnType<typeof setTimeout> | null = null
let viewStateTimer: ReturnType<typeof setTimeout> | null = null
let thumbBuffer: { id: number; status: 'ok' | 'fail' }[] = []
let thumbRaf: number | null = null

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
          dir: s.dir
        })
      )
      .catch(() => undefined)
  }, 400)
}

const VALID_SCOPES: PhotoScope[] = ['all', 'recent', 'missing', 'folder', 'album', 'tag', 'untagged']
const VALID_TILES = ['s', 'm', 'l'] as const
const VALID_SORTS: SortKey[] = ['taken', 'imported', 'name', 'rating', 'size']

/** 分页加载数量：首屏与每次增量加载 */
const PAGE_SIZE = 500

function buildQuery(s: AppState): PhotoQuery {
  return {
    scope: s.scope,
    scopeId: s.scopeId,
    keyword: s.keyword.trim() || undefined,
    dateFrom: s.dateFrom || undefined,
    dateTo: s.dateTo || undefined,
    minRating: s.minRating || undefined,
    sort: s.sort,
    dir: s.dir
  }
}

export const useStore = create<AppState>((set, get) => ({
  theme: 'dark',
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
  stats: { total: 0, missing: 0, untagged: 0 },
  photos: [],
  total: 0,
  loading: false,
  loadingMore: false,
  hasMore: false,
  lastQueryKey: null,
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
  appVersion: '',

  init: async () => {
    try {
      const saved = await api.getSetting('theme')
      const theme = saved === 'light' ? 'light' : 'dark'
      set({ theme })
      if (theme === 'light') api.setTheme('light')
    } catch {
      /* ignore */
    }
    // 恢复上次的视图状态与搜索历史
    try {
      const rawHistory = await api.getSetting('searchHistory')
      if (rawHistory) {
        const list = JSON.parse(rawHistory) as unknown
        if (Array.isArray(list)) {
          set({ searchHistory: list.filter((x): x is string => typeof x === 'string').slice(0, 10) })
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
        const needsId = scope === 'folder' || scope === 'album' || scope === 'tag'
        set({
          scope,
          scopeId: needsId && typeof v.scopeId === 'number' ? v.scopeId : undefined,
          tile: VALID_TILES.includes(v.tile as 's' | 'm' | 'l') ? (v.tile as 's' | 'm' | 'l') : 'm',
          sort: VALID_SORTS.includes(v.sort as SortKey) ? (v.sort as SortKey) : 'taken',
          dir: v.dir === 'asc' ? 'asc' : 'desc'
        })
      }
    } catch {
      /* ignore */
    }
    await get().refreshLibrary()
    // 校验作用域指向的文件夹/相册/标签是否仍存在，失效则回退到全部照片
    const st = get()
    const scopeGone =
      (st.scope === 'folder' && !st.folders.some((f) => f.id === st.scopeId)) ||
      (st.scope === 'album' && !st.albums.some((a) => a.id === st.scopeId)) ||
      (st.scope === 'tag' && !st.tags.some((t) => t.id === st.scopeId))
    if (scopeGone) set({ scope: 'all', scopeId: undefined })
    get().refreshPhotos()
    api
      .info()
      .then((i) => set({ appVersion: i.version }))
      .catch(() => undefined)
  },

  setTheme: (mode) => {
    set({ theme: mode })
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
      const [folders, tags, albums, stats] = await Promise.all([
        api.listFolders(),
        api.listTags(),
        api.listAlbums(),
        api.stats()
      ])
      set({ folders, tags, albums, stats })
    } catch {
      /* ignore */
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
      // 仅在过滤条件变化时按已加载结果裁剪选择集，后台数据刷新不破坏既有选择
      const selection = queryChanged
        ? (() => {
            const valid = new Set(r.items.map((p) => p.id))
            return new Set([...get().selection].filter((id) => valid.has(id)))
          })()
        : get().selection
      set({
        photos: r.items,
        total: r.total,
        hasMore: r.items.length < r.total,
        loading: false,
        selection,
        lastQueryKey: queryKey
      })
    } catch {
      set({ loading: false })
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
      const fresh = r.items.filter((p) => !loaded.has(p.id))
      const merged = [...photos, ...fresh]
      set({
        photos: merged,
        total: r.total,
        hasMore: merged.length < r.total,
        loadingMore: false
      })
    } catch {
      set({ loadingMore: false })
    }
  },

  toggleSelect: (id, opts) => {
    const { photos, selection, anchorId } = get()
    const next = new Set(selection)
    if (opts?.range && anchorId !== null) {
      const a = photos.findIndex((p) => p.id === anchorId)
      const b = photos.findIndex((p) => p.id === id)
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
    } catch {
      /* 查询失败保持原选择 */
    }
  },

  clearSelection: () => set({ selection: new Set(), anchorId: null }),

  openViewer: (id) => set({ activeId: id, viewerOpen: true }),

  closeViewer: () => set({ viewerOpen: false, activeId: get().activeId }),

  setActive: (id) => set({ activeId: id }),

  stepViewer: (delta) => {
    const { photos, activeId } = get()
    if (!photos.length) return
    const idx = photos.findIndex((p) => p.id === activeId)
    const next = idx < 0 ? 0 : Math.min(photos.length - 1, Math.max(0, idx + delta))
    set({ activeId: photos[next].id })
    // 接近已加载末尾时预取下一页，保证连续翻图
    if (next >= photos.length - 30) void get().loadMorePhotos()
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
    const idx = photos.findIndex((p) => p.id === anchorId)
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

  applyThumbEvents: (list) => {
    thumbBuffer.push(...list)
    if (thumbRaf !== null) return
    thumbRaf = requestAnimationFrame(() => {
      thumbRaf = null
      const updates = thumbBuffer
      thumbBuffer = []
      if (!updates.length) return
      const map = new Map(updates.map((u) => [u.id, u.status]))
      const now = Date.now()
      const photos = get().photos
      let touched = false
      const next = photos.map((p) => {
        const st = map.get(p.id)
        if (!st) return p
        touched = true
        return {
          ...p,
          thumb_status: (st === 'ok' ? 1 : 2) as 0 | 1 | 2,
          thumb_ts: now
        }
      })
      if (touched) set({ photos: next })
    })
  },

  patchPhoto: (id, patch) => {
    const photos = get().photos.map((p) => (p.id === id ? { ...p, ...patch } : p))
    set({ photos })
  }
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

/** 缩略图事件批量提交（rAF 节流） */
export function pushThumbEvent(e: { id: number; status: 'ok' | 'fail' }): void {
  useStore.getState().applyThumbEvents([e])
}
