import React, { useEffect, useRef, useState } from 'react'
import { Clock, FilePlus, FolderPlus, Grid3x3, Info, LayoutGrid, Search, SlidersHorizontal, Square, Trash2, X } from 'lucide-react'
import { useStore, type SortKey } from '../store'
import { emptyTrashAction, importFilesAction, importFolderAction, selectRedundantAction } from '../lib/actions'
import { SORT_OPTIONS } from '@shared/formats'
import { cn, ConfirmDialog, IconButton, StarRating, useOutsideClose } from './ui'

function useScopeLabel(): string {
  const scope = useStore((s) => s.scope)
  const scopeId = useStore((s) => s.scopeId)
  const folders = useStore((s) => s.folders)
  const albums = useStore((s) => s.albums)
  const smartAlbums = useStore((s) => s.smartAlbums)
  const tags = useStore((s) => s.tags)
  switch (scope) {
    case 'all':
      return '全部照片'
    case 'recent':
      return '最近导入'
    case 'untagged':
      return '未加标签'
    case 'missing':
      return '缺失文件'
    case 'trash':
      return '回收站'
    case 'folder':
      return folders.find((f) => f.id === scopeId)?.name ?? '文件夹'
    case 'album':
      return albums.find((a) => a.id === scopeId)?.name ?? '相册'
    case 'smart':
      return smartAlbums.find((a) => a.id === scopeId)?.name ?? '智能相册'
    case 'tag':
      return `# ${tags.find((t) => t.id === scopeId)?.name ?? '标签'}`
    default:
      return '照片'
  }
}

function FilterPopover({ onClose }: { onClose: () => void }): React.JSX.Element {
  const dateFrom = useStore((s) => s.dateFrom)
  const dateTo = useStore((s) => s.dateTo)
  const minRating = useStore((s) => s.minRating)
  const sort = useStore((s) => s.sort)
  const dir = useStore((s) => s.dir)
  const setFilter = useStore((s) => s.setFilter)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(ref, onClose)

  return (
    <div
      ref={ref}
      className="absolute right-0 top-10 z-40 w-[300px] rounded-xl border border-line bg-raised p-4 shadow-2xl animate-popIn"
    >
      <div className="space-y-3.5 text-[13px]">
        <div>
          <p className="mb-1.5 text-[11.5px] text-ink3">日期范围</p>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setFilter({ dateFrom: e.target.value })}
              className="flex-1 rounded-md border border-line bg-panel px-2 py-1.5 text-xs outline-none focus:border-[var(--c-accent)]"
            />
            <span className="text-ink3">至</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setFilter({ dateTo: e.target.value })}
              className="flex-1 rounded-md border border-line bg-panel px-2 py-1.5 text-xs outline-none focus:border-[var(--c-accent)]"
            />
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-[11.5px] text-ink3">最低星级</p>
          <StarRating value={minRating} onChange={(v) => setFilter({ minRating: v })} size={17} />
        </div>
        <div>
          <p className="mb-1.5 text-[11.5px] text-ink3">排序方式</p>
          <div className="flex gap-2">
            <select
              value={sort}
              onChange={(e) => setFilter({ sort: e.target.value as SortKey })}
              className="flex-1 rounded-md border border-line bg-panel px-2 py-1.5 text-xs outline-none"
            >
              {SORT_OPTIONS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <button
              onClick={() => setFilter({ dir: dir === 'desc' ? 'asc' : 'desc' })}
              className="rounded-md border border-line px-2.5 py-1.5 text-xs text-ink2 hover:bg-hover hover:text-ink"
            >
              {dir === 'desc' ? '降序' : '升序'}
            </button>
          </div>
        </div>
        {(dateFrom || dateTo || minRating > 0) && (
          <button
            onClick={() => setFilter({ dateFrom: '', dateTo: '', minRating: 0 })}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line py-1.5 text-xs text-ink2 hover:bg-hover hover:text-ink"
          >
            <X size={12} /> 清除筛选条件
          </button>
        )}
      </div>
    </div>
  )
}

export function Toolbar(): React.JSX.Element {
  const total = useStore((s) => s.total)
  const scope = useStore((s) => s.scope)
  const keyword = useStore((s) => s.keyword)
  const tile = useStore((s) => s.tile)
  const detailOpen = useStore((s) => s.detailOpen)
  const dateFrom = useStore((s) => s.dateFrom)
  const dateTo = useStore((s) => s.dateTo)
  const minRating = useStore((s) => s.minRating)
  const searchHistory = useStore((s) => s.searchHistory)
  const stats = useStore((s) => s.stats)
  const setKeyword = useStore((s) => s.setFilter)
  const setTile = useStore((s) => s.setTile)
  const toggleDetail = useStore((s) => s.toggleDetail)
  const label = useScopeLabel()

  const [input, setInput] = useState(keyword)
  const [filterOpen, setFilterOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const debounced = useRef<ReturnType<typeof setTimeout> | null>(null)

  useOutsideClose(searchRef, () => setHistoryOpen(false))

  // 外部关键词变化（如清除筛选）时同步输入框
  useEffect(() => setInput(keyword), [keyword])

  const onSearch = (v: string): void => {
    setInput(v)
    if (debounced.current) clearTimeout(debounced.current)
    debounced.current = setTimeout(() => {
      setKeyword({ keyword: v })
      if (v.trim()) useStore.getState().recordSearch(v)
    }, 250)
  }

  const applyHistory = (term: string): void => {
    setHistoryOpen(false)
    setKeyword({ keyword: term })
    setInput(term)
  }

  const activeFilterCount =
    (dateFrom ? 1 : 0) + (dateTo ? 1 : 0) + (minRating > 0 ? 1 : 0)

  return (
    <div className="relative flex h-12 shrink-0 items-center gap-2 border-b border-line bg-app px-4">
      <div className="min-w-0">
        <h1 className="truncate text-[14.5px] font-semibold leading-tight">{label}</h1>
        <p className="text-[11px] leading-tight text-ink3">{total} 张照片</p>
      </div>
      <div className="flex-1" />

      <div className="relative" ref={searchRef}>
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink3" />
        <input
          value={input}
          onChange={(e) => onSearch(e.target.value)}
          onFocus={() => {
            if (!input) setHistoryOpen(true)
          }}
          placeholder="搜索文件名、标题、标签…"
          className="h-8 w-[220px] rounded-md border border-line bg-panel pl-8 pr-7 text-[12.5px] outline-none transition-colors placeholder:text-ink3 focus:border-[var(--c-accent)] focus:w-[260px]"
        />
        {input && (
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ink3 hover:text-ink"
            onClick={() => onSearch('')}
            aria-label="清空搜索"
          >
            <X size={13} />
          </button>
        )}
        {historyOpen && searchHistory.length > 0 && (
          <div className="absolute left-0 top-10 z-40 w-[240px] rounded-lg border border-line bg-raised py-1 shadow-2xl animate-popIn">
            {searchHistory.map((h) => (
              <button
                key={h}
                onClick={() => applyHistory(h)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink2 hover:bg-hover hover:text-ink"
              >
                <Clock size={12} className="shrink-0 text-ink3" />
                <span className="flex-1 truncate">{h}</span>
              </button>
            ))}
            <div className="my-1 h-px bg-line" />
            <button
              onClick={() => {
                useStore.getState().clearSearchHistory()
                setHistoryOpen(false)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink3 hover:bg-hover hover:text-ink2"
            >
              <Trash2 size={12} /> 清空搜索历史
            </button>
          </div>
        )}
      </div>

      <div className="relative">
        <IconButton
          icon={
            <span className="relative">
              <SlidersHorizontal size={15} />
              {activeFilterCount > 0 && (
                <span className="absolute -right-1.5 -top-1.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-[var(--c-accent)] text-[8px] font-bold text-[#171310]">
                  {activeFilterCount}
                </span>
              )}
            </span>
          }
          label="筛选与排序"
          active={filterOpen || activeFilterCount > 0}
          onClick={() => setFilterOpen(!filterOpen)}
        />
        {filterOpen && <FilterPopover onClose={() => setFilterOpen(false)} />}
      </div>

      {scope === 'duplicates' && (
        <div className="flex items-center overflow-hidden rounded-md border border-line">
          <button
            onClick={() => void selectRedundantAction('best')}
            title="每组保留体积最大（其次最早导入）的一张，选中其余冗余项"
            className="h-8 px-2.5 text-[12px] text-ink2 hover:bg-hover hover:text-ink"
          >
            保留最佳
          </button>
          <span className="h-5 w-px bg-line" />
          <button
            onClick={() => void selectRedundantAction('oldest')}
            title="每组保留最早导入的一张，选中其余冗余项"
            className="h-8 px-2.5 text-[12px] text-ink2 hover:bg-hover hover:text-ink"
          >
            保留最早
          </button>
        </div>
      )}

      {scope === 'trash' && stats.trash > 0 && (
        <button
          onClick={() => setEmptyTrashOpen(true)}
          title="彻底删除回收站中的全部照片（移入系统回收站，无法在应用内还原）"
          className="flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-[12px] text-ink2 transition-colors hover:bg-hover hover:text-ink"
        >
          <Trash2 size={13} /> 清空回收站
        </button>
      )}

      <div className="mx-1 h-5 w-px bg-line" />

      <div className="flex items-center rounded-md border border-line">
        {(['s', 'm', 'l'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTile(t)}
            title={['小', '中', '大'][['s', 'm', 'l'].indexOf(t)] + '缩略图'}
            className={cn(
              'grid h-8 w-8 place-items-center transition-colors first:rounded-l-md last:rounded-r-md',
              tile === t ? 'bg-accent-soft text-accent' : 'text-ink3 hover:bg-hover hover:text-ink'
            )}
          >
            {t === 's' ? (
              <Grid3x3 size={13} strokeWidth={1.6} />
            ) : t === 'm' ? (
              <LayoutGrid size={13} strokeWidth={1.6} />
            ) : (
              <Square size={13} strokeWidth={1.6} />
            )}
          </button>
        ))}
      </div>

      <IconButton
        icon={<Info size={15} />}
        label="信息面板"
        active={detailOpen}
        onClick={toggleDetail}
      />

      <button
        onClick={() => void importFilesAction()}
        className="ml-1 flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-[12.5px] font-medium text-ink2 transition-colors hover:bg-hover hover:text-ink"
      >
        <FilePlus size={14} />
        导入文件
      </button>

      <button
        onClick={() => importFolderAction()}
        className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--c-accent)] px-3 text-[12.5px] font-medium text-[#171310] transition-colors hover:bg-[var(--c-accent-hover)]"
      >
        <FolderPlus size={14} />
        导入文件夹
      </button>

      <ConfirmDialog
        open={emptyTrashOpen}
        title="清空回收站"
        message={`将把回收站中的 ${stats.trash} 张照片移入系统回收站并从索引中移除（无法在应用内还原）。确定继续吗？`}
        confirmText="全部彻底删除"
        danger
        onClose={() => setEmptyTrashOpen(false)}
        onConfirm={() => {
          setEmptyTrashOpen(false)
          void emptyTrashAction()
        }}
      />
    </div>
  )
}
