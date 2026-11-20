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
  selection: Set<number>
  anchorId: number | null
  activeId: number | null
  viewerOpen: boolean
  detailOpen: boolean
  tile: 's' | 'm' | 'l'
  scan: ScanState
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
  toggleSelect: (id: number, opts?: { additive?: boolean; range?: boolean }) => void
  selectAll: () => void
  clearSelection: () => void
  openViewer: (id: number) => void
  closeViewer: () => void
  setActive: (id: number) => void
  stepViewer: (delta: number) => void
  toggleDetail: () => void
  setTile: (t: 's' | 'm' | 'l') => void
  setScan: (s: ScanState) => void
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
let thumbBuffer: { id: number; status: 'ok' | 'fail' }[] = []
let thumbRaf: number | null = null

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
  selection: new Set(),
  anchorId: null,
  activeId: null,
  viewerOpen: false,
  detailOpen: false,
  tile: 'm',
  scan: { active: false, label: '' },
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
    await get().refreshLibrary()
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
  },

  setFilter: (patch) => {
    set(patch as Partial<AppState>)
    get().refreshPhotos()
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
    set({ loading: true })
    try {
      const r = await api.queryPhotos(snapshot)
      if (
        JSON.stringify(buildQuery(get())) !== JSON.stringify(snapshot)
      ) {
        return // 过滤条件已变化，丢弃过期结果
      }
      const valid = new Set(r.items.map((p) => p.id))
      const selection = new Set([...get().selection].filter((id) => valid.has(id)))
      set({ photos: r.items, total: r.total, loading: false, selection })
    } catch {
      set({ loading: false })
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

  selectAll: () => {
    const next = new Set(get().photos.map((p) => p.id))
    set({ selection: next, anchorId: null })
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
  },

  toggleDetail: () => set({ detailOpen: !get().detailOpen }),

  setTile: (tile) => set({ tile }),

  setScan: (scan) => set({ scan }),

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
