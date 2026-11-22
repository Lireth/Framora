import React, { useEffect, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { Modal } from './ui'
import type { LibraryDistribution } from '@shared/types'

/**
 * 资料库统计（FEAT-08）：月度拍摄趋势 / 星级分布 / 标签 TOP / 相机占比。
 * 全部手写 SVG（零图表依赖），色条风格与 StoragePanel 一致。
 */

function Bar({ label, value, max, hint }: { label: string; value: number; max: number; hint?: string }): React.JSX.Element {
  const pct = max > 0 ? Math.max(value > 0 ? 4 : 0, (value / max) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="w-[92px] shrink-0 truncate text-right text-[11.5px] text-ink2" title={label}>
        {label}
      </span>
      <div className="h-3.5 min-w-0 flex-1 overflow-hidden rounded bg-panel">
        <div
          className="h-full rounded bg-[var(--c-accent)]/70"
          style={{ width: `${pct}%` }}
          title={hint ?? `${label}: ${value}`}
        />
      </div>
      <span className="w-[52px] shrink-0 text-right text-[11px] text-ink3">{value}</span>
    </div>
  )
}

/** 月度趋势：纵向柱状 SVG（近 24 个月，自动均分宽度） */
function MonthChart({ data }: { data: { ym: string; count: number }[] }): React.JSX.Element {
  const w = 480
  const h = 140
  const pad = 6
  const max = Math.max(1, ...data.map((d) => d.count))
  const n = Math.max(1, data.length)
  const bw = (w - pad * 2) / n
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[140px] w-full" role="img" aria-label="月度拍摄趋势">
      {data.map((d, i) => {
        const bh = Math.max(2, (d.count / max) * (h - 26))
        const x = pad + i * bw
        return (
          <g key={d.ym}>
            <rect
              x={x + bw * 0.12}
              y={h - 16 - bh}
              width={bw * 0.76}
              height={bh}
              rx={2}
              fill="var(--c-accent)"
              opacity={0.75}
            >
              <title>{`${d.ym}: ${d.count} 张`}</title>
            </rect>
            {(i % Math.ceil(n / 8) === 0 || i === n - 1) && (
              <text x={x + bw / 2} y={h - 4} textAnchor="middle" fontSize={9} fill="var(--c-ink3, #888)">
                {d.ym.slice(2)}
              </text>
            )}
            <text x={x + bw / 2} y={h - 18 - bh} textAnchor="middle" fontSize={9} fill="var(--c-ink3, #888)">
              {d.count > 0 ? d.count : ''}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export function StatsModal(): React.JSX.Element | null {
  const open = useStore((s) => s.statsOpen)
  const setOpen = useStore((s) => s.setStatsOpen)
  const stats = useStore((s) => s.stats)
  const [dist, setDist] = useState<LibraryDistribution | null>(null)

  useEffect(() => {
    if (!open) return
    api
      .distribution()
      .then(setDist)
      .catch(() => setDist(null))
  }, [open])

  const maxTag = dist ? Math.max(1, ...dist.topTags.map((t) => t.count)) : 1
  const maxCam = dist ? Math.max(1, ...dist.byCamera.map((t) => t.count)) : 1
  const camTotal = dist ? dist.byCamera.reduce((n, c) => n + c.count, 0) : 0

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="资料库统计" width={560}>
      {dist === null ? (
        <p className="py-8 text-center text-[13px] text-ink3">统计加载中…</p>
      ) : (
        <div className="space-y-6 text-[13px]">
          <div className="flex gap-4 rounded-lg border border-line bg-panel px-4 py-3 text-[12px] text-ink2">
            <span>
              总计 <b className="text-ink">{stats.total}</b> 张
            </span>
            <span>
              未加标签 <b className="text-ink">{stats.untagged}</b>
            </span>
            <span>
              缺失 <b className="text-ink">{stats.missing}</b>
            </span>
            <span>
              回收站 <b className="text-ink">{stats.trash}</b>
            </span>
          </div>

          <section>
            <p className="mb-2 flex items-center gap-1.5 font-medium">
              <BarChart3 size={14} /> 月度拍摄趋势（近 24 个月）
            </p>
            {dist.byMonth.length === 0 ? (
              <p className="text-[12px] text-ink3">暂无数据</p>
            ) : (
              <MonthChart data={dist.byMonth} />
            )}
          </section>

          <section>
            <p className="mb-2 font-medium">星级分布</p>
            <div className="space-y-1.5">
              {[5, 4, 3, 2, 1].map((r) => (
                <Bar key={r} label={`${'★'.repeat(r)}`} value={dist.byRating[r]} max={Math.max(1, ...dist.byRating.slice(1))} />
              ))}
              <Bar label="未评分" value={dist.byRating[0]} max={Math.max(1, ...dist.byRating.slice(1))} />
            </div>
          </section>

          <section>
            <p className="mb-2 font-medium">标签 TOP 10</p>
            {dist.topTags.length === 0 ? (
              <p className="text-[12px] text-ink3">暂无标签</p>
            ) : (
              <div className="space-y-1.5">
                {dist.topTags.map((t) => (
                  <Bar key={t.name} label={t.name} value={t.count} max={maxTag} />
                ))}
              </div>
            )}
          </section>

          <section>
            <p className="mb-2 font-medium">相机占比（解析到型号的照片共 {camTotal} 张）</p>
            {dist.byCamera.length === 0 ? (
              <p className="text-[12px] text-ink3">
                暂无相机数据——导入后索引管线会自动解析 EXIF 相机型号，存量照片将在后台逐步补全
              </p>
            ) : (
              <div className="space-y-1.5">
                {dist.byCamera.map((c) => (
                  <Bar
                    key={c.name}
                    label={c.name}
                    value={c.count}
                    max={maxCam}
                    hint={`${c.name}: ${c.count} 张（${Math.round((c.count / Math.max(1, camTotal)) * 100)}%）`}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  )
}
