import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { displayUrl } from '../lib/format'
import { cn, StarRating } from './ui'
import type { PhotoLite } from '@shared/types'

/**
 * 对比视图（FEAT-09）：两张照片并排显示，缩放/平移状态共享（同步联动）。
 * ←/→ 切换焦点，1-5 为焦点照片评分，+/−/0 缩放，Esc 关闭。
 */

const MIN_ZOOM = 0.15
const MAX_ZOOM = 8

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function CompareView(): React.JSX.Element | null {
  const compareIds = useStore((s) => s.compareIds)
  const closeCompare = useStore((s) => s.closeCompare)
  const photos = useStore((s) => s.photos)
  const [focus, setFocus] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const a = compareIds ? photos.find((p) => p.id === compareIds[0]) : undefined
  const b = compareIds ? photos.find((p) => p.id === compareIds[1]) : undefined
  const pair: [PhotoLite, PhotoLite] | null = a && b ? [a, b] : null

  // 缩放以视口中心为锚（双图共用同一组状态 → 天然同步）
  const zoomTo = (factor: number): void => {
    setZoom((z) => clamp(z * factor, MIN_ZOOM, MAX_ZOOM))
  }

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const wheel = (e: WheelEvent): void => {
      e.preventDefault()
      zoomTo(e.deltaY < 0 ? 1.15 : 1 / 1.15)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      const s = useStore.getState()
      if (!s.compareIds) return
      if (e.key === 'Escape') {
        e.preventDefault()
        s.closeCompare()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setFocus(0)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setFocus(1)
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        zoomTo(1.25)
      } else if (e.key === '-') {
        e.preventDefault()
        zoomTo(1 / 1.25)
      } else if (e.key === '0') {
        e.preventDefault()
        setZoom(1)
        setOffset({ x: 0, y: 0 })
      } else if (e.key >= '1' && e.key <= '5') {
        e.preventDefault()
        const id = s.compareIds[focus]
        void api
          .updateMeta(id, { rating: Number(e.key) })
          .then(() => s.patchPhoto(id, { rating: Number(e.key) }))
          .catch(() => s.toast('error', '评分失败'))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [focus])

  if (!compareIds || !pair) return null
  const focusId = pair[focus].id
  const focusRating = photos.find((p) => p.id === focusId)?.rating ?? 0

  return (
    <div className="fixed inset-0 z-[55] flex flex-col bg-black/95 animate-fadeIn">
      {/* 顶栏：名称 + 焦点评分 */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-white/10 px-4 text-white/80">
        <span className="text-[12.5px] font-semibold">
          对比视图
          <span className="ml-2 text-[11px] text-white/40">←/→ 切换焦点 · 1-5 评分 · 滚轮缩放 · Esc 关闭</span>
        </span>
        <span className={cn('truncate text-[12px]', focus === 0 ? 'text-accent' : 'text-white/40')}>
          A：{pair[0].name}
        </span>
        <span className={cn('truncate text-[12px]', focus === 1 ? 'text-accent' : 'text-white/40')}>
          B：{pair[1].name}
        </span>
        <div className="flex-1" />
        <StarRating
          value={focusRating}
          size={15}
          onChange={async (v) => {
            await api.updateMeta(focusId, { rating: v })
            useStore.getState().patchPhoto(focusId, { rating: v })
          }}
        />
        <button onClick={closeCompare} aria-label="关闭对比 (Esc)" className="text-white/60 hover:text-white">
          <X size={18} />
        </button>
      </div>

      {/* 双画布：共享 zoom/offset */}
      <div ref={wrapRef} className="relative flex min-h-0 flex-1">
        {pair.map((p, i) => (
          <div
            key={p.id}
            className={cn(
              'relative flex min-w-0 flex-1 items-center justify-center overflow-hidden',
              i === 0 && 'border-r border-white/10'
            )}
            onPointerDown={(e) => {
              ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
              dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
              setFocus(i)
            }}
            onPointerMove={(e) => {
              const d = dragRef.current
              if (!d) return
              setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) })
            }}
            onPointerUp={() => {
              dragRef.current = null
            }}
            style={{ cursor: 'grab', touchAction: 'none' }}
            onDragStart={(e) => e.preventDefault()}
          >
            <img
              src={displayUrl(p)}
              alt={p.name}
              draggable={false}
              className={cn(
                'max-h-full max-w-full select-none transition-[outline] outline outline-2',
                focus === i ? 'outline-[var(--c-accent)]' : 'outline-transparent'
              )}
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              }}
            />
            <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white/80">
              {i === 0 ? 'A' : 'B'} · {p.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
