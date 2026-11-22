import React, { useEffect, useMemo, useRef, useState } from 'react'
import { MapPin, Square, X } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { thumbUrl } from '../lib/format'
import { formatDate } from '@shared/formats'
import { cn } from './ui'
import type { GeoPhoto } from '@shared/types'

/**
 * 地点视图（FEAT-07）：等距圆柱投影的离线 SVG 世界示意底图（经纬网格），
 * GPS 照片按 ~2° 网格聚簇为圆点（半径随数量增长）。点击簇弹出照片清单
 * （缩略图 / 打开查看器 / OSM 外链）。完全离线——不上传任何数据，
 * 仅在用户显式点击「OSM」时经系统浏览器打开网页地图。
 * 框选选片（FEAT-21）：开启「框选」后拖出矩形，框内照片进入选择集
 * （复用全局选择模型——批量栏随之出现，可评分/加标签/入相册）。
 */

/** 聚簇网格度数：约 220km 纬向粒度 */
const CELL_DEG = 2
const MAP_W = 720
const MAP_H = 360

interface Cluster {
  key: string
  lat: number
  lon: number
  items: GeoPhoto[]
}

function cluster(list: GeoPhoto[]): Cluster[] {
  const cells = new Map<string, Cluster>()
  for (const p of list) {
    const key = `${Math.round(p.lat / CELL_DEG)}:${Math.round(p.lon / CELL_DEG)}`
    const c = cells.get(key)
    if (c) {
      c.items.push(p)
      c.lat = c.items.reduce((n, x) => n + x.lat, 0) / c.items.length
      c.lon = c.items.reduce((n, x) => n + x.lon, 0) / c.items.length
    } else {
      cells.set(key, { key, lat: p.lat, lon: p.lon, items: [p] })
    }
  }
  return [...cells.values()]
}

/** SVG 像素 → 经纬度（等距圆柱投影的逆变换） */
function svgToLatLon(x: number, y: number): { lat: number; lon: number } {
  return { lat: 90 - (y / MAP_H) * 180, lon: (x / MAP_W) * 360 - 180 }
}

export function MapPanel(): React.JSX.Element {
  const openViewer = useStore((s) => s.openViewer)
  const [all, setAll] = useState<GeoPhoto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<Cluster | null>(null)
  // 框选选片（FEAT-21）
  const [selectMode, setSelectMode] = useState(false)
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  /** 客户端坐标 → SVG viewBox 坐标（preserveAspectRatio="meet" 的居中偏移修正） */
  const toSvg = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = svgRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return null
    const scale = Math.min(r.width / MAP_W, r.height / MAP_H)
    const ox = (r.width - MAP_W * scale) / 2
    const oy = (r.height - MAP_H * scale) / 2
    return {
      x: Math.max(0, Math.min(MAP_W, (clientX - r.left - ox) / scale)),
      y: Math.max(0, Math.min(MAP_H, (clientY - r.top - oy) / scale)),
    }
  }

  const finishSelect = (r: { x0: number; y0: number; x1: number; y1: number }): void => {
    const a = svgToLatLon(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1))
    const b = svgToLatLon(Math.max(r.x0, r.x1), Math.max(r.y0, r.y1))
    if (!all) return
    const ids = all
      .filter((p) => p.lat >= a.lat && p.lat <= b.lat && p.lon >= a.lon && p.lon <= b.lon)
      .map((p) => p.id)
    const s = useStore.getState()
    if (ids.length) {
      s.setSelection(ids)
      s.toast('success', `已框选 ${ids.length} 张照片，可用批量栏评分 / 加标签 / 入相册`)
    } else {
      s.toast('info', '框选区域内没有带定位的照片')
    }
  }

  useEffect(() => {
    let cancelled = false
    api
      .queryGeoPhotos()
      .then((r) => {
        if (!cancelled) setAll(r)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const clusters = useMemo(() => (all ? cluster(all) : []), [all])

  const px = (lon: number): number => (lon + 180) * (MAP_W / 360)
  const py = (lat: number): number => (90 - lat) * (MAP_H / 180)

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-ink3">
        <MapPin size={30} />
        <p className="text-[13px] text-ink2">地点数据加载失败：{error}</p>
        <button
          onClick={() => {
            setError(null)
            api
              .queryGeoPhotos()
              .then(setAll)
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          }}
          className="rounded-md border border-line px-3 py-1.5 text-xs text-ink2 hover:bg-hover hover:text-ink"
        >
          重试
        </button>
      </div>
    )
  }

  if (all === null) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-ink3">
        正在加载地点数据…
      </div>
    )
  }

  if (all.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-ink3">
        <MapPin size={30} />
        <p className="text-[13px] text-ink2">没有带 GPS 信息的照片</p>
        <p className="max-w-[420px] text-[11.5px] leading-relaxed">
          手机或相机拍摄的带定位照片会在导入/索引时自动解析经纬度并出现在这里。
        </p>
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col p-3">
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[11.5px] text-ink3">
          {all.length} 张带定位照片 · {clusters.length} 个聚合点 ·
          离线示意投影（等距圆柱），点击聚合点查看照片；OSM 为外部网页地图
        </p>
        <button
          onClick={() => {
            setSelectMode((v) => !v)
            setRect(null)
          }}
          className={cn(
            'flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11.5px] transition-colors',
            selectMode
              ? 'border-[var(--c-accent)] bg-accent-soft text-accent'
              : 'border-line text-ink2 hover:bg-hover hover:text-ink'
          )}
          title="拖出矩形，框内照片进入选择集（可批量评分 / 加标签 / 入相册）"
        >
          <Square size={12} /> {selectMode ? '框选中（点击退出）' : '框选照片'}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-raised">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${MAP_W} ${MAP_H}`}
          className={cn('h-full w-full', selectMode && 'cursor-crosshair')}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`世界地点分布：${all.length} 张照片，${clusters.length} 个聚合点`}
          onPointerDown={(e) => {
            if (!selectMode) return
            const p = toSvg(e.clientX, e.clientY)
            if (!p) return
            e.currentTarget.setPointerCapture(e.pointerId)
            setRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
          }}
          onPointerMove={(e) => {
            if (!selectMode || !rect) return
            const p = toSvg(e.clientX, e.clientY)
            if (!p) return
            setRect({ ...rect, x1: p.x, y1: p.y })
          }}
          onPointerUp={(e) => {
            if (!selectMode || !rect) return
            const p = toSvg(e.clientX, e.clientY)
            const final = p ? { ...rect, x1: p.x, y1: p.y } : rect
            setRect(null)
            // 极小矩形视为误触，不改变选择集
            if (Math.abs(final.x1 - final.x0) > 4 || Math.abs(final.y1 - final.y0) > 4) {
              finishSelect(final)
            }
          }}
        >
          {/* 经纬网格：30° 间隔 */}
          {[-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150].map((lon) => (
            <line
              key={`lon${lon}`}
              x1={px(lon)}
              y1={0}
              x2={px(lon)}
              y2={MAP_H}
              stroke="var(--c-line)"
              strokeWidth={lon === 0 ? 1.2 : 0.6}
            />
          ))}
          {[-60, -30, 0, 30, 60].map((lat) => (
            <line
              key={`lat${lat}`}
              x1={0}
              y1={py(lat)}
              x2={MAP_W}
              y2={py(lat)}
              stroke="var(--c-line)"
              strokeWidth={lat === 0 ? 1.2 : 0.6}
            />
          ))}
          {/* 框选矩形（FEAT-21） */}
          {selectMode && rect && (
            <rect
              x={Math.min(rect.x0, rect.x1)}
              y={Math.min(rect.y0, rect.y1)}
              width={Math.abs(rect.x1 - rect.x0)}
              height={Math.abs(rect.y1 - rect.y0)}
              fill="var(--c-accent)"
              fillOpacity={0.12}
              stroke="var(--c-accent)"
              strokeWidth={1.2}
              strokeDasharray="4 3"
              style={{ pointerEvents: 'none' }}
            />
          )}
          {/* 聚合点 */}
          {clusters.map((c) => {
            const n = c.items.length
            const r = 5 + Math.min(18, Math.log2(n + 1) * 5)
            return (
              <g
                key={c.key}
                onClick={() => !selectMode && setActive(c)}
                className={selectMode ? '' : 'cursor-pointer'}
                data-testid={`geo-cluster-${c.key}`}
              >
                <circle
                  cx={px(c.lon)}
                  cy={py(c.lat)}
                  r={r}
                  fill="var(--c-accent)"
                  fillOpacity={0.35}
                  stroke="var(--c-accent)"
                  strokeWidth={1.5}
                >
                  <title>{`${n} 张 · ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}`}</title>
                </circle>
                {n > 1 && (
                  <text
                    x={px(c.lon)}
                    y={py(c.lat) + 3.5}
                    textAnchor="middle"
                    fontSize={10}
                    fill="var(--c-accent)"
                    className="select-none"
                    style={{ pointerEvents: 'none' }}
                  >
                    {n}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      {/* 簇照片弹层 */}
      {active && (
        <div className="absolute bottom-3 right-3 top-10 flex w-[300px] flex-col rounded-xl border border-line bg-raised shadow-2xl animate-popIn">
          <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
            <span className="text-[12.5px] font-semibold">
              {active.items.length} 张 · {active.lat.toFixed(2)}, {active.lon.toFixed(2)}
            </span>
            <button
              className="text-ink3 hover:text-ink"
              onClick={() => setActive(null)}
              aria-label="关闭列表"
            >
              <X size={14} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {active.items.slice(0, 50).map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded-md p-1.5 hover:bg-hover">
                <img
                  src={thumbUrl(p)}
                  alt={p.name}
                  className="h-10 w-10 shrink-0 rounded object-cover"
                  draggable={false}
                  loading="lazy"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-ink2">{p.name}</p>
                  <p className="text-[10.5px] text-ink3">{formatDate(p.taken_at)}</p>
                </div>
                <button
                  className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink2 hover:bg-hover hover:text-ink"
                  onClick={() => openViewer(p.id)}
                >
                  查看
                </button>
                <button
                  className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink2 hover:bg-hover hover:text-ink"
                  onClick={() => api.openInMap(p.lat, p.lon).catch(() => undefined)}
                  title="在 OpenStreetMap 中打开（外部浏览器）"
                >
                  OSM
                </button>
              </div>
            ))}
            {active.items.length > 50 && (
              <p className="px-2 py-2 text-[11px] text-ink3">
                仅显示前 50 张，可按拍摄时间在网格视图缩小范围
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
