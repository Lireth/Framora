import React, { useEffect, useState } from 'react'
import {
  Camera,
  ChevronDown,
  ExternalLink,
  FolderInput,
  Images,
  MapPin,
  Plus,
  Tag,
  X
} from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { formatDateTime, formatBytes, thumbUrl } from '../lib/format'
import { cn, StarRating } from './ui'
import { TagPicker } from './TagPicker'
import type { MetaPair, PhotoRecord } from '@shared/types'

/** 解析 EXIF 面板的 GPS 坐标字符串（主进程格式："31.23041, 121.47370"） */
function parseGps(value: string): { lat: number; lon: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value)
  if (!m) return null
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { lat, lon }
}

function Field({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-2 py-[3px] text-[12px] leading-snug">
      <span className="w-[56px] shrink-0 text-ink3">{label}</span>
      <span className="min-w-0 flex-1 break-all text-ink2">{value}</span>
    </div>
  )
}

function SectionTitle({
  icon,
  children
}: {
  icon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink3">
      {icon}
      {children}
    </div>
  )
}

export function DetailPanel({ inViewer }: { inViewer?: boolean }): React.JSX.Element | null {
  const activeId = useStore((s) => s.activeId)
  const selection = useStore((s) => s.selection)
  const albums = useStore((s) => s.albums)
  const [record, setRecord] = useState<PhotoRecord | null>(null)
  const [exif, setExif] = useState<MetaPair[] | null>(null)
  const [showExif, setShowExif] = useState(false)
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const [albumMenuOpen, setAlbumMenuOpen] = useState(false)

  const id = inViewer ? activeId : selection.size === 1 ? [...selection][0] : activeId
  // 评分订阅自 store 的照片列表：快捷键等外部评分更新时星级行即时反映
  const storeRating = useStore((s) =>
    id === null ? undefined : s.photos.find((p) => p.id === id)?.rating
  )

  useEffect(() => {
    if (id === null) {
      setRecord(null)
      setExif(null)
      return
    }
    let cancelled = false
    api
      .getPhoto(id)
      .then((r) => {
        if (!cancelled) setRecord(r)
      })
      .catch(() => undefined)
    api
      .metadata(id)
      .then((r) => {
        if (!cancelled) setExif(r.pairs)
      })
      .catch(() => {
        if (!cancelled) setExif([])
      })
    return () => {
      cancelled = true
    }
  }, [id, record?.mtime])

  if (!record) {
    return (
      <aside className={cn('flex w-[300px] shrink-0 flex-col items-center justify-center border-l border-line bg-panel text-ink3', inViewer && 'h-full')}>
        <p className="text-[12px]">选中一张照片查看详情</p>
      </aside>
    )
  }

  const refresh = async (): Promise<void> => {
    const r = await api.getPhoto(record.id).catch(() => null)
    if (r) setRecord(r)
    useStore.getState().refreshLibrary()
  }

  return (
    <aside
      className={cn(
        'flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel',
        inViewer && 'h-full border-l-0'
      )}
    >
      {/* 预览 */}
      <div className="p-3 pb-0">
        <div className="overflow-hidden rounded-lg bg-raised">
          {record.thumb_status === 1 ? (
            <img
              src={thumbUrl(record)}
              alt={record.name}
              className="max-h-[190px] w-full object-contain"
              draggable={false}
            />
          ) : (
            <div className="thumb-skeleton h-[140px] w-full" />
          )}
        </div>
        <p className="mt-2 truncate text-[13px] font-medium" title={record.path}>
          {record.name}
        </p>
        <p className="text-[11px] text-ink3">{record.ext.toUpperCase()} · {formatBytes(record.size)}</p>
      </div>

      <div className="space-y-4 p-3">
        {/* 评分 */}
        <div>
          <SectionTitle icon={<Camera size={11} />}>评分</SectionTitle>
          <StarRating
            value={storeRating ?? record.rating}
            size={17}
            onChange={async (v) => {
              await api.updateMeta(record.id, { rating: v })
              useStore.getState().patchPhoto(record.id, { rating: v })
              void refresh()
            }}
          />
        </div>

        {/* 标题 / 描述 */}
        <div className="space-y-2">
          <input
            value={record.title ?? ''}
            placeholder="标题…"
            onChange={(e) => setRecord({ ...record, title: e.target.value })}
            onBlur={async (e) => {
              await api.updateMeta(record.id, { title: e.target.value || null })
              void refresh()
            }}
            className="w-full rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--c-accent)]"
          />
          <textarea
            value={record.description ?? ''}
            placeholder="描述备注…"
            rows={3}
            onChange={(e) => setRecord({ ...record, description: e.target.value })}
            onBlur={async (e) => {
              await api.updateMeta(record.id, { description: e.target.value || null })
              void refresh()
            }}
            className="w-full resize-none rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--c-accent)]"
          />
        </div>

        {/* 标签 */}
        <div className="relative">
          <SectionTitle icon={<Tag size={11} />}>标签</SectionTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            {record.tags.map((t) => (
              <span
                key={t.id}
                className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] text-accent"
              >
                {t.name}
                <button
                  onClick={async () => {
                    await api.setTags(
                      record.id,
                      record.tags.filter((x) => x.id !== t.id).map((x) => x.id)
                    )
                    void refresh()
                  }}
                  className="opacity-60 hover:opacity-100"
                  aria-label={`移除标签 ${t.name}`}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            <button
              onClick={() => setTagPickerOpen(!tagPickerOpen)}
              className="flex items-center gap-0.5 rounded-full border border-dashed border-line px-2 py-0.5 text-[11.5px] text-ink3 hover:border-[var(--c-accent)] hover:text-accent"
            >
              <Plus size={10} /> 添加
            </button>
          </div>
          {tagPickerOpen && (
            <TagPicker
              photoIds={[record.id]}
              onClose={() => setTagPickerOpen(false)}
            />
          )}
        </div>

        {/* 相册 */}
        <div className="relative">
          <SectionTitle icon={<Images size={11} />}>所属相册</SectionTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            {record.albums.length === 0 && <span className="text-[11.5px] text-ink3">未加入相册</span>}
            {record.albums.map((a) => (
              <span
                key={a.id}
                className="flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-[11.5px] text-ink2"
              >
                {a.name}
                <button
                  onClick={async () => {
                    await api.removeAlbum(record.id, a.id)
                    void refresh()
                  }}
                  className="opacity-60 hover:opacity-100"
                  aria-label={`移出相册 ${a.name}`}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            <button
              onClick={() => setAlbumMenuOpen(!albumMenuOpen)}
              className="flex items-center gap-0.5 rounded-full border border-dashed border-line px-2 py-0.5 text-[11.5px] text-ink3 hover:border-[var(--c-accent)] hover:text-accent"
            >
              <Plus size={10} /> 加入
            </button>
          </div>
          {albumMenuOpen && (
            <div className="absolute left-0 top-full z-30 mt-1 min-w-[160px] rounded-lg border border-line bg-raised py-1 shadow-2xl animate-popIn">
              {albums
                .filter((a) => !record.albums.some((ra) => ra.id === a.id))
                .map((a) => (
                  <button
                    key={a.id}
                    onClick={async () => {
                      await api.batchAlbum([record.id], a.id)
                      setAlbumMenuOpen(false)
                      void refresh()
                    }}
                    className="block w-full px-3 py-1.5 text-left text-[12.5px] text-ink2 hover:bg-hover hover:text-ink"
                  >
                    {a.name}
                  </button>
                ))}
              {albums.length === record.albums.length && (
                <p className="px-3 py-2 text-[11.5px] text-ink3">没有可加入的相册</p>
              )}
            </div>
          )}
        </div>

        {/* 文件信息 */}
        <div>
          <SectionTitle icon={<FolderInput size={11} />}>文件信息</SectionTitle>
          <Field label="尺寸" value={record.width && record.height ? `${record.width} × ${record.height}` : '未知'} />
          <Field label="拍摄" value={record.taken_at ? formatDateTime(record.taken_at) : '未知'} />
          <Field label="导入" value={formatDateTime(record.imported_at)} />
          <Field label="路径" value={<span className="select-text">{record.path}</span>} />
        </div>

        {/* EXIF */}
        <div>
          <button
            className="flex w-full items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink3 hover:text-ink2"
            onClick={() => setShowExif(!showExif)}
          >
            <ChevronDown size={11} className={cn('transition-transform', showExif && 'rotate-180')} />
            相机信息 (EXIF)
          </button>
          {showExif && (
            <div className="mt-1.5 rounded-lg border border-line bg-raised px-2.5 py-2">
              {exif === null && <p className="text-[11.5px] text-ink3">读取中…</p>}
              {exif !== null &&
                exif
                  .filter((p) => !['文件名', '格式', '尺寸', '大小', '拍摄时间', '导入时间', '路径'].includes(p.label))
                  .map((p) => {
                    // GPS 行附带「在地图中打开」：坐标合法时外链 OpenStreetMap
                    const gps = p.label === 'GPS' ? parseGps(p.value) : null
                    return (
                      <Field
                        key={p.label + p.value}
                        label={p.label}
                        value={
                          gps ? (
                            <span className="flex items-center gap-1.5">
                              <span className="select-text">{p.value}</span>
                              <button
                                onClick={() =>
                                  api.openInMap(gps.lat, gps.lon).catch(() => undefined)
                                }
                                className="flex shrink-0 items-center gap-0.5 text-[11px] text-accent hover:underline"
                              >
                                <MapPin size={11} /> 地图
                              </button>
                            </span>
                          ) : (
                            p.value
                          )
                        }
                      />
                    )
                  })}
              {exif !== null && exif.length <= 7 && (
                <p className="text-[11.5px] text-ink3">此文件没有可用的相机元数据</p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-auto border-t border-line p-3">
        <button
          onClick={() => api.openInExplorer(record.id).catch(() => undefined)}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line py-1.5 text-[12px] text-ink2 hover:bg-hover hover:text-ink"
        >
          <ExternalLink size={12} /> 在资源管理器中显示
        </button>
        {!inViewer && (
          <p className="mt-2 text-center text-[10.5px] text-ink3">双击照片可打开全屏查看器</p>
        )}
      </div>
    </aside>
  )
}
