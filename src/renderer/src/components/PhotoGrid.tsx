import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertTriangle, Check, FolderPlus, ImageOff, SearchX } from 'lucide-react'
import { useStore } from '../store'
import { thumbUrl } from '../lib/format'
import { cn, StarRating, type MenuItem } from './ui'
import { useContextMenu } from './useContextMenu'
import { api } from '../lib/api'
import { importFolderAction, restorePhotosAction } from '../lib/actions'
import { TagPicker } from './TagPicker'
import type { PhotoLite } from '@shared/types'

const TILE_PX = { s: 128, m: 172, l: 228 } as const
const GAP = 10
/** 时间线分组头部行高 */
const HEADER_H = 34

interface GridRow {
  kind: 'header' | 'tiles'
  label?: string
  /** 头部行归属的 [年, 月(0-11)]：时间线锚点条跳转与压缩展示用 */
  ym?: [number, number]
  items?: PhotoLite[]
}

/**
 * 瓦片单元：memo 化后仅在自身 photo 引用 / 尺寸变化时重渲。
 * photos 数组被整体替换（patchPhoto/查询刷新）时，未变更项引用不变，可跳过渲染；
 * 选择态与缩略图状态（OPT-41 独立切片）均按 id 细粒度订阅，不依赖父级重渲——
 * 导入期的缩略图事件不再触发任何未变更瓦片与行模型的重建。
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
  const scope = useStore((s) => s.scope)
  const toggleSelect = useStore((s) => s.toggleSelect)
  const openViewer = useStore((s) => s.openViewer)
  const { open: openMenu, element: menuElement } = useContextMenu()
  const [imgFailed, setImgFailed] = useState(false)
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const thumbOv = useStore((s) => s.thumbStatus.get(p.id))
  const eff = thumbOv ?? { status: p.thumb_status, ts: p.thumb_ts }

  // 重新生成成功（事件切片 ts 变化）后重置本地 img 加载失败标记，换新缓存戳重载
  useEffect(() => {
    setImgFailed(false)
  }, [eff.ts])

  const menuItems: MenuItem[] = [
    { label: '打开查看器', onClick: () => openViewer(p.id) },
    {
      label: selected ? '取消选择' : '选中',
      onClick: () => toggleSelect(p.id, { additive: true })
    },
    { separator: true },
    ...(scope === 'trash'
      ? [
          {
            label: '还原到原位置',
            onClick: () => void restorePhotosAction([p.id])
          },
          {
            label: '彻底删除（移入系统回收站）',
            danger: true,
            onClick: () => {
              useStore.getState().clearSelection()
              useStore.getState().toggleSelect(p.id)
              useStore.getState().setConfirmDeleteOpen(true)
            }
          }
        ] as MenuItem[]
      : ([
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
          // 缩略图生成失败的手动恢复路径：主进程以紧急优先级重排队（FEAT-19）
          ...(eff.status === 2 || imgFailed
            ? ([
                {
                  label: '重新生成缩略图',
                  onClick: () => {
                    // 重置本地 img 加载失败标记，重生成成功后新 thumb_ts 会换 src
                    setImgFailed(false)
                    api
                      .regenerateThumb(p.id)
                      .catch(() => useStore.getState().toast('error', '重新生成缩略图失败'))
                  }
                }
              ] as MenuItem[])
            : []),
          {
            label: '删除（移入回收站）',
            danger: true,
            onClick: () => {
              useStore.getState().clearSelection()
              useStore.getState().toggleSelect(p.id)
              useStore.getState().setConfirmDeleteOpen(true)
            }
          }
        ] as MenuItem[])
    )
  ]

  return (
    <div
      role="button"
      aria-label={`${p.name}${selected ? '（已选中）' : ''}`}
      className={cn(
        'group relative shrink-0 overflow-hidden rounded-lg bg-raised transition-all duration-150',
        selected ? 'ring-2 ring-[var(--c-accent)]' : 'hover:ring-1 hover:ring-[var(--c-line)]'
      )}
      style={{ width: tileW, height: tileH }}
      draggable={!p.missing}
      onDragStart={(e) => {
        // 选中集合整体拖拽，否则只拖当前瓦片；改为原生 OS 拖拽（携带真实文件路径）后
        // 同一手势既可拖出窗口到资源管理器，也可放回侧边栏相册/标签（经拖拽会话匹配）
        const ids = useStore.getState().selection.has(p.id) ? [...useStore.getState().selection] : [p.id]
        e.preventDefault()
        useStore.getState().setDraggingPhotos(ids)
        void api.dragOutPhotos(ids).catch(() => undefined)
      }}
      onDragEnd={() => useStore.getState().setDraggingPhotos(null)}
      onClick={(e) =>
        toggleSelect(p.id, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey })
      }
      onDoubleClick={() => openViewer(p.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        if (!selected) toggleSelect(p.id)
        openMenu(e.clientX, e.clientY, menuItems)
      }}
    >
      {/* 缩略图（生效状态 = 事件切片覆盖 ?? 行内值，OPT-41） */}
      {p.missing ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-ink3">
          <ImageOff size={22} />
          <span className="text-[10px]">文件缺失</span>
        </div>
      ) : eff.status === 0 ? (
        <div className="thumb-skeleton h-full w-full" />
      ) : eff.status === 2 || imgFailed ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-ink3">
          <AlertTriangle size={20} />
          <span className="text-[10px]">无法生成缩略图</span>
        </div>
      ) : (
        <img
          src={thumbUrl({ id: p.id, thumb_ts: eff.ts })}
          alt={p.name}
          loading="lazy"
          draggable={false}
          onError={() => setImgFailed(true)}
          className="h-full w-full object-cover animate-fadeIn"
        />
      )}

      {/* 选择圈标记：显隐由 CSS group-hover 驱动（外层已有 group 类），悬停不再触发 setState 重渲染 */}
      <button
        className={cn(
          'absolute left-1.5 top-1.5 grid h-[18px] w-[18px] place-items-center rounded-full border transition-colors',
          selected
            ? 'border-[var(--c-accent)] bg-[var(--c-accent)] opacity-100'
            : 'border-white/70 bg-black/30 opacity-0 backdrop-blur group-hover:opacity-100'
        )}
        onClick={(e) => {
          e.stopPropagation()
          toggleSelect(p.id, { additive: true })
        }}
        aria-label="选择"
      >
        {selected && <Check size={11} className="text-[#171310]" strokeWidth={3.2} />}
      </button>

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

      {menuElement}
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
  const tagIds = useStore((s) => s.tagIds)
  const albumIds = useStore((s) => s.albumIds)
  const folderIds = useStore((s) => s.folderIds)
  const untagged = useStore((s) => s.untagged)
  // 含组合筛选（FEAT-18）：空态需给出「清除搜索与筛选」的出路
  const hasFilter = !!(
    dateFrom ||
    dateTo ||
    minRating ||
    tagIds.length ||
    albumIds.length ||
    folderIds.length ||
    untagged
  )

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
            useStore.getState().setFilter({
              keyword: '',
              dateFrom: '',
              dateTo: '',
              minRating: 0,
              tagIds: [],
              albumIds: [],
              folderIds: [],
              untagged: false
            })
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
  const photosError = useStore((s) => s.photosError)
  const hasMore = useStore((s) => s.hasMore)
  const anchorId = useStore((s) => s.anchorId)
  const navTick = useStore((s) => s.navTick)
  const setGridCols = useStore((s) => s.setGridCols)
  const loadMorePhotos = useStore((s) => s.loadMorePhotos)
  const sort = useStore((s) => s.sort)
  const scope = useStore((s) => s.scope)
  const scopeId = useStore((s) => s.scopeId)
  const smartAlbums = useStore((s) => s.smartAlbums)
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

  /* 分组所依据的「实际生效排序」：主进程对 recent 恒按 imported_at 排（忽略 sort 参数），
     smart scope 的固定排序覆盖工具栏排序（resolveSmartFilters），其余用工具栏排序。
     分组键必须与实际排序一致，否则同一月份的头部会交错重复出现 */
  const activeSort = useMemo<'taken' | 'imported' | 'name' | 'rating' | 'size'>(() => {
    if (scope === 'recent') return 'imported'
    if (scope === 'smart' && scopeId !== undefined) {
      const saved = smartAlbums.find((a) => a.id === scopeId)?.query.sort
      if (saved) return saved
    }
    return sort
  }, [scope, scopeId, smartAlbums, sort])

  /* 行模型：按拍摄/导入月份分组的头部行 + 瓦片行（时间线视图）；
     疑似重复按簇排列、回收站按删除时间倒序，两者均不做分月分组 */
  const { rows, rowIndexOfPhoto } = useMemo(() => {
    const groupable =
      scope !== 'duplicates' &&
      scope !== 'trash' &&
      scope !== 'map' &&
      (activeSort === 'taken' || activeSort === 'imported')
    const monthKey = (p: PhotoLite): [number, number] => {
      // 与主进程排序键一致：imported 排序按导入时间，其余（taken）按 sort_ts =
      // COALESCE(taken_at, imported_at) 的取值逻辑
      const ts = activeSort === 'imported' ? p.imported_at : (p.taken_at ?? p.imported_at)
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
        rowsOut.push({ kind: 'header', label: `${y}年${m + 1}月`, ym: [y, m] })
      }
      bucket.push(p)
      if (bucket.length === cols) flush()
    }
    flush()
    return { rows: rowsOut, rowIndexOfPhoto: indexById }
  }, [photos, cols, activeSort, scope])

  /* 时间线锚点条数据：头部行的压缩标签与行号（≥2 个月份时显示） */
  const monthHeaders = useMemo(
    () =>
      rows.flatMap((r, i) =>
        r.kind === 'header' && r.ym ? [{ row: i, ym: r.ym }] : []
      ),
    [rows]
  )

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

  // 当前可视区所处月份：首个可视行之前最近的头部行（高亮锚点）
  const firstVisibleRow = virtualizer.getVirtualItems()[0]?.index ?? -1
  let activeMonthIdx = -1
  for (let i = 0; i < monthHeaders.length; i++) {
    if (monthHeaders[i].row <= firstVisibleRow) activeMonthIdx = i
    else break
  }

  // 锚点条内部跟随高亮滚动（仅滚动锚点容器本身，不影响网格滚动位置）
  const anchorListRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const list = anchorListRef.current
    if (activeMonthIdx < 0 || !list) return
    const el = list.querySelector<HTMLElement>(`[data-idx="${activeMonthIdx}"]`)
    if (!el) return
    const top = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2
    list.scrollTop = Math.max(0, Math.min(top, list.scrollHeight - list.clientHeight))
  }, [activeMonthIdx])

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={parentRef}
        className="absolute inset-0 overflow-y-auto overflow-x-hidden px-3 py-3"
        data-testid="photo-grid"
      >
        {photos.length === 0 ? (
          photosError ? (
            /* 查询失败：可重试错误态，避免误导性空态（OPT-20） */
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-ink3">
              <SearchX size={30} />
              <p className="text-[13px] text-ink2">照片查询失败：{photosError}</p>
              <button
                onClick={() => void useStore.getState().refreshPhotos()}
                className="rounded-md border border-line px-3 py-1.5 text-xs text-ink2 hover:bg-hover hover:text-ink"
              >
                重试
              </button>
            </div>
          ) : loading ? (
            /* 首个 IPC 往返期间展示骨架屏，替代误导性的「没有照片」空态 */
            <div className="flex flex-wrap content-start gap-[10px] px-1 pt-1">
              {Array.from({ length: 24 }, (_, i) => (
                <div
                  key={i}
                  className="thumb-skeleton rounded-lg"
                  style={{ width: tileW, height: tileH }}
                />
              ))}
            </div>
          ) : (
            <EmptyState />
          )
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
      </div>
      {/* 时间线月份锚点条：月份 ≥2 时显示，点击跳转到对应分组头部 */}
      {monthHeaders.length >= 2 && (
        <div
          ref={anchorListRef}
          className="absolute right-1.5 top-1/2 z-10 max-h-[72%] -translate-y-1/2 overflow-y-auto rounded-lg border border-line bg-raised/85 py-1 shadow-lg backdrop-blur-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {monthHeaders.map((h, i) => (
            <button
              key={`${h.ym[0]}-${h.ym[1]}`}
              data-idx={i}
              onClick={() => virtualizer.scrollToIndex(h.row, { align: 'start' })}
              className={cn(
                'block w-full px-2 py-0.5 text-center text-[10.5px] font-medium tabular-nums transition-colors',
                i === activeMonthIdx ? 'bg-accent-soft text-accent' : 'text-ink3 hover:text-ink'
              )}
              title={`${h.ym[0]}年${h.ym[1] + 1}月`}
            >
              {String(h.ym[0] % 100).padStart(2, '0')}.{h.ym[1] + 1}
            </button>
          ))}
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
