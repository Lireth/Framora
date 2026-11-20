import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertTriangle, Check, FolderPlus, ImageOff, SearchX } from 'lucide-react'
import { useStore } from '../store'
import { thumbUrl } from '../lib/format'
import { cn, ContextMenu, StarRating, type MenuItem } from './ui'
import { api } from '../lib/api'
import { importFolderAction } from '../lib/actions'
import { TagPicker } from './TagPicker'
import type { PhotoLite } from '@shared/types'

const TILE_PX = { s: 128, m: 172, l: 228 } as const
const GAP = 10
/** 时间线分组头部行高 */
const HEADER_H = 34

interface GridRow {
  kind: 'header' | 'tiles'
  label?: string
  items?: PhotoLite[]
}

/**
 * 瓦片单元：memo 化后仅在自身 photo 引用 / 尺寸变化时重渲。
 * photos 数组被整体替换（patchPhoto/缩略图回填）时，未变更项引用不变，可跳过渲染；
 * 选择态经由 selection.has(id) 细粒度订阅，不依赖父级重渲。
 */
const Tile = React.memo(function Tile({
  p,
  tileW,
  tileH
}: {
  p: PhotoLite
  tileW: number
  tileH: number
}): React.JSX.Element {
  const selected = useStore((s) => s.selection.has(p.id))
  const toggleSelect = useStore((s) => s.toggleSelect)
  const openViewer = useStore((s) => s.openViewer)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [imgFailed, setImgFailed] = useState(false)
  const [hover, setHover] = useState(false)
  const [tagPickerOpen, setTagPickerOpen] = useState(false)

  const menuItems: MenuItem[] = [
    { label: '打开查看器', onClick: () => openViewer(p.id) },
    {
      label: selected ? '取消选择' : '选中',
      onClick: () => toggleSelect(p.id, { additive: true })
    },
    { separator: true },
    {
      label: '添加标签…',
      onClick: () => setTagPickerOpen(true)
    },
    {
      label: '导出…',
      onClick: () => useStore.getState().openExport([p.id])
    },
    { separator: true },
    {
      label: '在资源管理器中显示',
      onClick: () => api.openInExplorer(p.id).catch(() => undefined)
    },
    {
      label: '删除（移入回收站）',
      danger: true,
      onClick: () => {
        useStore.getState().clearSelection()
        useStore.getState().toggleSelect(p.id)
        useStore.getState().setConfirmDeleteOpen(true)
      }
    }
  ]

  return (
    <div
      className={cn(
        'group relative shrink-0 overflow-hidden rounded-lg bg-raised transition-all duration-150',
        selected ? 'ring-2 ring-[var(--c-accent)]' : 'hover:ring-1 hover:ring-[var(--c-line)]'
      )}
      style={{ width: tileW, height: tileH }}
      draggable={!p.missing}
      onDragStart={(e) => {
        // 选中集合整体拖拽，否则只拖当前瓦片
        const ids = useStore.getState().selection.has(p.id) ? [...useStore.getState().selection] : [p.id]
        e.dataTransfer.setData('application/x-framora-photos', JSON.stringify(ids))
        e.dataTransfer.effectAllowed = 'copyMove'
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) =>
        toggleSelect(p.id, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey })
      }
      onDoubleClick={() => openViewer(p.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        if (!selected) toggleSelect(p.id)
        setMenu({ x: e.clientX, y: e.clientY, items: menuItems })
      }}
    >
      {/* 缩略图 */}
      {p.missing ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-ink3">
          <ImageOff size={22} />
          <span className="text-[10px]">文件缺失</span>
        </div>
      ) : p.thumb_status === 0 ? (
        <div className="thumb-skeleton h-full w-full" />
      ) : p.thumb_status === 2 || imgFailed ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-ink3">
          <AlertTriangle size={20} />
          <span className="text-[10px]">无法生成缩略图</span>
        </div>
      ) : (
        <img
          src={thumbUrl(p)}
          alt={p.name}
          loading="lazy"
          draggable={false}
          onError={() => setImgFailed(true)}
          className="h-full w-full object-cover animate-fadeIn"
        />
      )}

      {/* 选择圈标记 */}
      {(selected || hover) && (
        <button
          className={cn(
            'absolute left-1.5 top-1.5 grid h-[18px] w-[18px] place-items-center rounded-full border transition-colors',
            selected
              ? 'border-[var(--c-accent)] bg-[var(--c-accent)]'
              : 'border-white/70 bg-black/30 backdrop-blur'
          )}
          onClick={(e) => {
            e.stopPropagation()
            toggleSelect(p.id, { additive: true })
          }}
          aria-label="选择"
        >
          {selected && <Check size={11} className="text-[#171310]" strokeWidth={3.2} />}
        </button>
      )}

      {/* 星级角标 */}
      {p.rating > 0 && (
        <div className="absolute bottom-1 left-1.5 flex rounded bg-black/55 px-1 py-0.5 backdrop-blur-sm">
          <StarRating value={p.rating} size={9} />
        </div>
      )}

      {tagPickerOpen && (
        <TagPicker
          photoIds={[p.id]}
          onClose={() => setTagPickerOpen(false)}
        />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  )
})

function EmptyState(): React.JSX.Element {
  const folders = useStore((s) => s.folders)
  const total = useStore((s) => s.total)
  const keyword = useStore((s) => s.keyword)
  const dateFrom = useStore((s) => s.dateFrom)
  const dateTo = useStore((s) => s.dateTo)
  const minRating = useStore((s) => s.minRating)
  const hasFilter = !!(dateFrom || dateTo || minRating)

  if (folders.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <div className="grid h-16 w-16 place-items-center rounded-2xl bg-accent-soft">
          <FolderPlus size={28} className="text-accent" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">从导入第一个文件夹开始</h2>
          <p className="mt-1.5 max-w-[380px] text-[13px] leading-relaxed text-ink2">
            拾帧会自动扫描文件夹中的照片并建立索引，
            <br />
            之后文件夹内有任何变动都会自动同步，无需重复导入。
          </p>
        </div>
        <button
          onClick={() => importFolderAction()}
          className="rounded-md bg-[var(--c-accent)] px-4 py-2 text-[13px] font-medium text-[#171310] hover:bg-[var(--c-accent-hover)]"
        >
          选择文件夹导入
        </button>
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-ink3">
      <SearchX size={30} />
      <p className="text-[13px] text-ink2">
        {keyword ? `没有匹配「${keyword}」的照片` : '当前筛选条件下没有照片'}
      </p>
      {(keyword || hasFilter) && (
        <button
          onClick={() =>
            useStore.getState().setFilter({ keyword: '', dateFrom: '', dateTo: '', minRating: 0 })
          }
          className="rounded-md border border-line px-3 py-1.5 text-xs text-ink2 hover:bg-hover hover:text-ink"
        >
          清除搜索与筛选
        </button>
      )}
      {total > 0 && <p className="text-[11px]">资料库共有 {total} 张照片</p>}
    </div>
  )
}

export function PhotoGrid(): React.JSX.Element {
  const photos = useStore((s) => s.photos)
  const tile = useStore((s) => s.tile)
  const loading = useStore((s) => s.loading)
  const hasMore = useStore((s) => s.hasMore)
  const anchorId = useStore((s) => s.anchorId)
  const navTick = useStore((s) => s.navTick)
  const setGridCols = useStore((s) => s.setGridCols)
  const loadMorePhotos = useStore((s) => s.loadMorePhotos)
  const sort = useStore((s) => s.sort)
  const scope = useStore((s) => s.scope)
  const parentRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1200)

  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const tileH = TILE_PX[tile]
  const cols = Math.max(2, Math.floor((width + GAP) / (tileH + GAP)))
  const tileW = Math.floor((width - (cols - 1) * GAP) / cols)

  /* 行模型：按拍摄/导入月份分组的头部行 + 瓦片行（时间线视图）；疑似重复视图按簇排列不分月 */
  const { rows, rowIndexOfPhoto } = useMemo(() => {
    const groupable =
      scope !== 'duplicates' && (scope === 'recent' || sort === 'taken' || sort === 'imported')
    const monthKey = (p: PhotoLite): [number, number] => {
      const ts = scope === 'recent' || sort === 'imported' ? p.imported_at : (p.taken_at ?? p.imported_at)
      const d = new Date(ts)
      return [d.getFullYear(), d.getMonth()]
    }
    const rowsOut: GridRow[] = []
    const indexById = new Map<number, number>()
    if (!groupable) {
      for (let i = 0; i < photos.length; i += cols) {
        const items = photos.slice(i, i + cols)
        for (const p of items) indexById.set(p.id, rowsOut.length)
        rowsOut.push({ kind: 'tiles', items })
      }
      return { rows: rowsOut, rowIndexOfPhoto: indexById }
    }
    let curKey = ''
    let bucket: PhotoLite[] = []
    const flush = (): void => {
      if (!bucket.length) return
      for (const p of bucket) indexById.set(p.id, rowsOut.length)
      rowsOut.push({ kind: 'tiles', items: bucket })
      bucket = []
    }
    for (const p of photos) {
      const [y, m] = monthKey(p)
      const key = `${y}-${m}`
      if (key !== curKey) {
        flush()
        curKey = key
        rowsOut.push({ kind: 'header', label: `${y}年${m + 1}月` })
      }
      bucket.push(p)
      if (bucket.length === cols) flush()
    }
    flush()
    return { rows: rowsOut, rowIndexOfPhoto: indexById }
  }, [photos, cols, sort, scope])

  // 上报列数，供方向键导航按行列位移
  useEffect(() => {
    setGridCols(cols)
  }, [cols, setGridCols])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (rows[i].kind === 'header' ? HEADER_H : tileH + GAP),
    overscan: 4
  })

  // 键盘导航后把锚点所在行滚动到可视区
  useEffect(() => {
    if (!navTick || anchorId === null) return
    const row = rowIndexOfPhoto.get(anchorId)
    if (row === undefined) return
    virtualizer.scrollToIndex(row, { align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navTick])

  // 滚动接近底部时增量加载下一页
  useEffect(() => {
    if (!hasMore) return
    const items = virtualizer.getVirtualItems()
    const last = items.length ? items[items.length - 1].index : -1
    if (last >= rows.length - 3) void loadMorePhotos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualizer.getVirtualItems().length, rows.length, hasMore])

  return (
    <div
      ref={parentRef}
      className="relative flex-1 overflow-y-auto overflow-x-hidden px-3 py-3"
      data-testid="photo-grid"
    >
      {photos.length === 0 ? (
        <EmptyState />
      ) : (
        <div
          style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index]
            return (
              <div
                key={vi.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: vi.size,
                  transform: `translateY(${vi.start}px)`
                }}
              >
                {row.kind === 'header' ? (
                  <div
                    className="flex items-end pb-1.5 text-[12px] font-semibold tracking-wide text-ink2"
                    style={{ height: HEADER_H }}
                  >
                    {row.label}
                  </div>
                ) : (
                  <div className="flex" style={{ gap: GAP }}>
                    {row.items!.map((p) => (
                      <Tile key={p.id} p={p} tileW={tileW} tileH={tileH} />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {loading && (
        <div className="pointer-events-none absolute right-5 top-3 rounded-full bg-raised/80 px-3 py-1 text-[11px] text-ink2 shadow">
          加载中…
        </div>
      )}
    </div>
  )
}
