import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ChevronLeft,
  ChevronRight,
  Crop,
  FlipHorizontal2,
  FlipVertical2,
  Loader2,
  Maximize,
  Pencil,
  RotateCcw,
  RotateCw,
  Undo2,
  X,
  Save,
  ExternalLink,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { mediaUrl, thumbUrl, formatBytes } from '../lib/format'
import { cn, IconButton, PrimaryButton, GhostButton } from './ui'
import { DetailPanel } from './DetailPanel'
import type { CropRect, PhotoLite } from '@shared/types'

interface EditState {
  rotateDelta: number
  flipH: boolean
  flipV: boolean
  brightness: number
  contrast: number
  saturation: number
  temperature: number
  tint: number
  sharpen: number
  crop: CropRect | null
}
const EDIT_RESET: EditState = {
  rotateDelta: 0,
  flipH: false,
  flipV: false,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  sharpen: 0,
  crop: null
}

type Aspect = 'free' | '1:1' | '4:3' | '3:2' | '16:9'
const ASPECT_RATIOS: [Aspect, number, number][] = [
  ['free', 0, 0],
  ['1:1', 1, 1],
  ['4:3', 4, 3],
  ['3:2', 3, 2],
  ['16:9', 16, 9]
]

const MIN_ZOOM = 0.15
const MAX_ZOOM = 8

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

const STRIP_ITEM = 56
const STRIP_GAP = 6

function Filmstrip({ activeId }: { activeId: number | null }): React.JSX.Element {
  const photos = useStore((s) => s.photos)
  const setActive = useStore((s) => s.setActive)
  const stripRef = useRef<HTMLDivElement>(null)

  // 横向虚拟化：万级库下只挂载可视区内的胶片格
  const virtualizer = useVirtualizer({
    count: photos.length,
    getScrollElement: () => stripRef.current,
    estimateSize: () => STRIP_ITEM + STRIP_GAP,
    horizontal: true,
    overscan: 8
  })

  useEffect(() => {
    if (activeId === null) return
    const idx = photos.findIndex((p) => p.id === activeId)
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  return (
    <div
      ref={stripRef}
      className="absolute bottom-0 left-0 right-0 flex h-[74px] items-center overflow-x-auto overflow-y-hidden border-t border-white/10 bg-black/60 px-3 backdrop-blur"
    >
      <div style={{ width: virtualizer.getTotalSize(), height: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const p = photos[vi.index]
          return (
            <button
              key={p.id}
              data-photo={p.id}
              onClick={() => setActive(p.id)}
              style={{
                position: 'absolute',
                top: (74 - STRIP_ITEM) / 2,
                left: 0,
                width: STRIP_ITEM,
                height: STRIP_ITEM,
                transform: `translateX(${vi.start}px)`
              }}
              className={cn(
                'shrink-0 overflow-hidden rounded-md transition-all',
                p.id === activeId
                  ? 'ring-2 ring-[var(--c-accent)] opacity-100'
                  : 'opacity-55 hover:opacity-95'
              )}
            >
              {p.thumb_status === 1 ? (
                <img src={thumbUrl(p)} alt="" className="h-full w-full object-cover" draggable={false} />
              ) : (
                <div className="h-full w-full bg-white/10" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function EditPanel({
  edit,
  setEdit,
  photo,
  onSaved,
  cropMode,
  aspect,
  setAspect,
  onToggleCrop
}: {
  edit: EditState
  setEdit: (e: EditState) => void
  photo: PhotoLite
  onSaved: () => void
  cropMode: boolean
  aspect: Aspect
  setAspect: (a: Aspect) => void
  onToggleCrop: () => void
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)

  const slider = (
    label: string,
    key: 'brightness' | 'contrast' | 'saturation' | 'temperature' | 'tint' | 'sharpen',
    min = -100,
    max = 100
  ): React.JSX.Element => (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] text-ink2">{label}</span>
        <button
          className="text-[11px] text-ink3 hover:text-ink"
          onClick={() => setEdit({ ...edit, [key]: 0 })}
        >
          {edit[key]}
        </button>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={edit[key]}
        onChange={(e) => setEdit({ ...edit, [key]: Number(e.target.value) })}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-line"
        style={{ accentColor: 'var(--c-accent)' }}
      />
    </div>
  )

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.saveEdits(photo.id, { ...edit, crop: edit.crop ?? undefined })
      useStore.getState().toast('success', '编辑已保存（原文件已备份）')
      const rec = await api.getPhoto(photo.id)
      useStore.getState().patchPhoto(photo.id, {
        size: rec.size,
        mtime: rec.mtime,
        thumb_status: 0
      })
      onSaved()
    } catch (e) {
      useStore.getState().toast('error', e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const saveAs = async (): Promise<void> => {
    setExporting(true)
    try {
      const dir = await api.pickExportDir()
      if (dir) {
        const r = await api.exportPhotos([photo.id], dir, { format: 'original' })
        useStore.getState().toast('success', `已导出到 ${dir}（${r.exported} 张）`)
      }
    } catch (e) {
      useStore.getState().toast('error', e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const revert = async (): Promise<void> => {
    try {
      await api.revertEdits(photo.id)
      useStore.getState().toast('success', '已恢复到编辑前')
      setEdit(EDIT_RESET)
      useStore.getState().patchPhoto(photo.id, { thumb_status: 0 })
      onSaved()
    } catch (e) {
      useStore.getState().toast('error', e instanceof Error ? e.message : '没有可恢复的备份')
    }
  }

  return (
    <div className="absolute right-0 top-11 bottom-[74px] z-10 w-[248px] overflow-y-auto border-l border-white/10 bg-[#141418]/95 p-4 backdrop-blur">
      <h3 className="mb-3 text-[13px] font-semibold text-white/90">基础编辑</h3>
      <div className="space-y-3">
        {slider('亮度', 'brightness')}
        {slider('对比度', 'contrast')}
        {slider('饱和度', 'saturation')}
        {slider('色温', 'temperature')}
        {slider('色调', 'tint')}
        {slider('锐化', 'sharpen', 0, 100)}
      </div>
      {edit.sharpen > 0 && (
        <p className="mt-1 text-[10.5px] text-white/35">锐化在保存时应用，实时预览不可见。</p>
      )}
      <div className="mt-4 flex gap-1.5">
        <button
          className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-white/15 text-[12px] text-white/80 hover:bg-white/10"
          onClick={() => setEdit({ ...edit, rotateDelta: edit.rotateDelta - 90 })}
        >
          <RotateCcw size={13} /> 左转
        </button>
        <button
          className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-white/15 text-[12px] text-white/80 hover:bg-white/10"
          onClick={() => setEdit({ ...edit, rotateDelta: edit.rotateDelta + 90 })}
        >
          <RotateCw size={13} /> 右转
        </button>
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <button
          className={cn(
            'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border text-[12px] hover:bg-white/10',
            edit.flipH ? 'border-[var(--c-accent)] text-accent' : 'border-white/15 text-white/80'
          )}
          onClick={() => setEdit({ ...edit, flipH: !edit.flipH })}
        >
          <FlipHorizontal2 size={13} /> 水平翻转
        </button>
        <button
          className={cn(
            'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border text-[12px] hover:bg-white/10',
            edit.flipV ? 'border-[var(--c-accent)] text-accent' : 'border-white/15 text-white/80'
          )}
          onClick={() => setEdit({ ...edit, flipV: !edit.flipV })}
        >
          <FlipVertical2 size={13} /> 垂直翻转
        </button>
      </div>

      {/* 裁剪 */}
      <div className="mt-2">
        <button
          className={cn(
            'flex h-8 w-full items-center justify-center gap-1.5 rounded-md border text-[12px] hover:bg-white/10',
            cropMode || edit.crop
              ? 'border-[var(--c-accent)] text-accent'
              : 'border-white/15 text-white/80'
          )}
          disabled={edit.rotateDelta !== 0 || edit.flipH || edit.flipV}
          title={
            edit.rotateDelta !== 0 || edit.flipH || edit.flipV
              ? '重置旋转/翻转后可使用裁剪'
              : undefined
          }
          onClick={onToggleCrop}
        >
          <Crop size={13} /> {cropMode ? '退出裁剪' : '裁剪'}
        </button>
        {cropMode && (
          <>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {ASPECT_RATIOS.map(([a]) => (
                <button
                  key={a}
                  className={cn(
                    'rounded border px-1.5 py-0.5 text-[11px] transition-colors',
                    aspect === a
                      ? 'border-[var(--c-accent)] text-accent'
                      : 'border-white/15 text-white/60 hover:text-white/90'
                  )}
                  onClick={() => setAspect(a)}
                >
                  {a === 'free' ? '自由' : a}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10.5px] text-white/35">在画面上拖拽框选裁剪区域。</p>
          </>
        )}
        {edit.crop && !cropMode && (
          <button
            className="mt-1.5 h-7 w-full rounded-md border border-white/15 text-[11.5px] text-white/60 hover:bg-white/10"
            onClick={() => setEdit({ ...edit, crop: null })}
          >
            清除裁剪区域
          </button>
        )}
      </div>

      <button
        className="mt-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-white/15 text-[12px] text-white/70 hover:bg-white/10"
        onClick={() => setEdit(EDIT_RESET)}
      >
        <RotateCcw size={12} /> 重置调整
      </button>

      <div className="mt-4 space-y-2 border-t border-white/10 pt-3">
        <button
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-white/15 text-[12px] text-white/70 hover:bg-white/10"
          onClick={revert}
        >
          <Undo2 size={13} /> 撤销编辑（恢复备份）
        </button>
        <GhostButton onClick={saveAs} disabled={exporting}>
          <span className="flex items-center justify-center gap-1.5">
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />}
            另存为副本…
          </span>
        </GhostButton>
        <PrimaryButton onClick={save} disabled={saving}>
          <span className="flex items-center justify-center gap-1.5">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            保存修改
          </span>
        </PrimaryButton>
      </div>
      <p className="mt-3 text-[10.5px] leading-relaxed text-white/35">
        保存会直接写入原文件，原文件自动备份到应用数据目录，可随时撤销恢复。
      </p>
    </div>
  )
}

export function Viewer(): React.JSX.Element {
  const photos = useStore((s) => s.photos)
  const activeId = useStore((s) => s.activeId)
  const stepViewer = useStore((s) => s.stepViewer)
  const closeViewer = useStore((s) => s.closeViewer)
  const detailOpen = useStore((s) => s.detailOpen)
  const toggleDetail = useStore((s) => s.toggleDetail)

  const photo = photos.find((p) => p.id === activeId) ?? photos[0]

  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [edit, setEdit] = useState<EditState>(EDIT_RESET)
  const [editOpen, setEditOpen] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  /* 裁剪模式状态 */
  const [cropMode, setCropMode] = useState(false)
  const [aspect, setAspect] = useState<Aspect>('free')
  const cropStartRef = useRef<{ x: number; y: number } | null>(null)
  const [draggingCrop, setDraggingCrop] = useState(false)
  const [imgBox, setImgBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)

  useEffect(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setEdit(EDIT_RESET)
    setCropMode(false)
  }, [activeId])

  // 裁剪模式：跟踪画面内图像盒位置用于绘制选框与遮罩
  useEffect(() => {
    if (!cropMode) {
      setImgBox(null)
      return
    }
    const update = (): void => {
      const c = containerRef.current?.getBoundingClientRect()
      const r = imgRef.current?.getBoundingClientRect()
      if (c && r && r.width > 0 && r.height > 0) {
        setImgBox({ left: r.left - c.left, top: r.top - c.top, width: r.width, height: r.height })
      }
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [cropMode])

  const relInImg = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const r = imgRef.current?.getBoundingClientRect()
    if (!r || r.width === 0 || r.height === 0) return null
    return {
      x: clamp((clientX - r.left) / r.width, 0, 1),
      y: clamp((clientY - r.top) / r.height, 0, 1)
    }
  }

  const toggleCrop = (): void => {
    if (cropMode) {
      setCropMode(false)
      setEdit({ ...edit, crop: null })
    } else {
      setEdit({ ...edit, crop: null })
      setZoom(1)
      setOffset({ x: 0, y: 0 })
      setCropMode(true)
    }
  }

  // 预取相邻原图（±2），翻页时即时呈现
  useEffect(() => {
    if (!photo) return
    const idx = photos.findIndex((p) => p.id === photo.id)
    for (const d of [-1, 1, -2, 2]) {
      const p = photos[idx + d]
      if (!p || p.missing) continue
      const img = new Image()
      img.src = mediaUrl(p)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo?.id])

  const zoomTo = useCallback(
    (factor: number, cx?: number, cy?: number): void => {
      setZoom((z) => {
        const nz = clamp(z * factor, MIN_ZOOM, MAX_ZOOM)
        const k = nz / z
        if (cx !== undefined && cy !== undefined) {
          setOffset((o) => ({
            x: cx - (cx - o.x) * k,
            y: cy - (cy - o.y) * k
          }))
        } else {
          setOffset((o) => ({ x: o.x * k, y: o.y * k }))
        }
        return nz
      })
    },
    []
  )

  const resetZoom = useCallback((): void => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  /* 查看器快捷键：+/− 缩放、0 复位、F 全屏 */
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key
      if (k === '+' || k === '=') {
        e.preventDefault()
        zoomTo(1.25)
      } else if (k === '-') {
        e.preventDefault()
        zoomTo(1 / 1.25)
      } else if (k === '0') {
        e.preventDefault()
        resetZoom()
      } else if (k.toLowerCase() === 'f') {
        void api.toggleFullscreen().catch(() => undefined)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [zoomTo, resetZoom])

  // 滚轮缩放使用原生非被动监听：React 的 onWheel 为 passive，preventDefault 无效
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left - rect.width / 2
      const cy = e.clientY - rect.top - rect.height / 2
      zoomTo(e.deltaY < 0 ? 1.16 : 1 / 1.16, cx, cy)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [zoomTo])

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    if (cropMode) {
      const rel = relInImg(e.clientX, e.clientY)
      if (!rel) return
      cropStartRef.current = rel
      setEdit({ ...edit, crop: { x: rel.x, y: rel.y, w: 0, h: 0 } })
      setDraggingCrop(true)
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      return
    }
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: offset.x, oy: offset.y }
    setDragging(true)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (cropMode) {
      if (!draggingCrop || !cropStartRef.current) return
      const rel = relInImg(e.clientX, e.clientY)
      const r = imgRef.current?.getBoundingClientRect()
      if (!rel || !r || r.width === 0 || r.height === 0) return
      const s = cropStartRef.current
      let pxW = (rel.x - s.x) * r.width
      let pxH = (rel.y - s.y) * r.height
      const ratio = ASPECT_RATIOS.find((a) => a[0] === aspect)
      if (ratio && ratio[1] > 0) {
        const ar = ratio[1] / ratio[2]
        if (Math.abs(pxW) / Math.max(1, Math.abs(pxH)) > ar) {
          pxH = Math.sign(pxH || 1) * Math.abs(pxW) / ar
        } else {
          pxW = Math.sign(pxW || 1) * Math.abs(pxH) * ar
        }
      }
      const x1 = clamp(Math.min(s.x, s.x + pxW / r.width), 0, 1)
      const y1 = clamp(Math.min(s.y, s.y + pxH / r.height), 0, 1)
      const x2 = clamp(Math.max(s.x, s.x + pxW / r.width), 0, 1)
      const y2 = clamp(Math.max(s.y, s.y + pxH / r.height), 0, 1)
      setEdit({ ...edit, crop: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } })
      return
    }
    const d = dragRef.current
    if (!d) return
    setOffset({ x: d.ox + (e.clientX - d.startX), y: d.oy + (e.clientY - d.startY) })
  }
  const onPointerUp = (): void => {
    cropStartRef.current = null
    setDraggingCrop(false)
    dragRef.current = null
    setDragging(false)
  }

  if (!photo) {
    return (
      <div className="fixed inset-0 z-40 grid place-items-center bg-black/90">
        <button onClick={closeViewer} className="text-white/60 hover:text-white">
          关闭
        </button>
      </div>
    )
  }

  const rotation = (photo.orientation || 0) + edit.rotateDelta
  // 色温/色调用 CSS 滤镜做方向性近似预览（保存时按精确通道增益写盘）
  const t = edit.temperature / 100
  const tintF = edit.tint / 100
  const cssFilter = [
    `brightness(${1 + edit.brightness / 100})`,
    `contrast(${1 + edit.contrast / 100})`,
    `saturate(${1 + edit.saturation / 100})`,
    t > 0 ? `sepia(${(t * 0.35).toFixed(3)})` : t < 0 ? `hue-rotate(${(t * 14).toFixed(2)}deg)` : '',
    tintF !== 0 ? `hue-rotate(${(tintF * 8).toFixed(2)}deg)` : ''
  ]
    .filter(Boolean)
    .join(' ')
  const idx = photos.findIndex((p) => p.id === photo.id)

  return (
    <div className="fixed inset-0 z-40 animate-fadeIn bg-black/95">
      {/* 顶栏 */}
      <div className="absolute left-0 right-0 top-0 z-20 flex h-11 items-center gap-2 border-b border-white/10 bg-black/60 px-3 backdrop-blur">
        <span className="max-w-[280px] truncate text-[13px] font-medium text-white/90">
          {photo.name}
        </span>
        <span className="text-[11px] text-white/35">
          {idx + 1} / {photos.length} · {photo.width && photo.height ? `${photo.width}×${photo.height}` : ''} ·{' '}
          {formatBytes(photo.size)}
        </span>
        <div className="flex-1" />
        <IconButton
          icon={<RotateCcw size={15} />}
          label="向左旋转 90°"
          onClick={() => setEdit({ ...edit, rotateDelta: edit.rotateDelta - 90 })}
        />
        <IconButton
          icon={<RotateCw size={15} />}
          label="向右旋转 90°"
          onClick={() => setEdit({ ...edit, rotateDelta: edit.rotateDelta + 90 })}
        />
        <IconButton
          icon={<FlipHorizontal2 size={15} />}
          label="水平翻转"
          active={edit.flipH}
          onClick={() => setEdit({ ...edit, flipH: !edit.flipH })}
        />
        <span className="mx-1 h-5 w-px bg-white/15" />
        <IconButton
          icon={<Pencil size={15} />}
          label="编辑"
          active={editOpen}
          onClick={() => setEditOpen(!editOpen)}
        />
        <IconButton
          icon={<ChevronRight size={15} className={detailOpen ? 'rotate-180' : ''} />}
          label="信息面板"
          active={detailOpen}
          onClick={toggleDetail}
        />
        <IconButton icon={<X size={16} />} label="关闭 (Esc)" onClick={closeViewer} />
      </div>

      {/* 画布 */}
      <div
        ref={containerRef}
        className="absolute bottom-[74px] left-0 top-11 flex items-center justify-center overflow-hidden"
        style={{ right: editOpen ? 248 : 0 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={cropMode ? undefined : () => zoomTo(zoom === 1 ? 2.5 : 1 / zoom)}
      >
        <img
          ref={imgRef}
          src={mediaUrl(photo)}
          alt={photo.name}
          draggable
          onDragStart={(e) => {
            e.preventDefault()
            // 放大状态下拖拽留给平移，仅在原始视图下把原文件拖出到资源管理器
            if (zoom !== 1) return
            void api.dragOutPhotos([photo.id]).catch(() => undefined)
          }}
          style={{
            ...( { WebkitUserDrag: 'element' } as React.CSSProperties ),
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom}) rotate(${rotation}deg) scaleX(${edit.flipH ? -1 : 1}) scaleY(${edit.flipV ? -1 : 1})`,
            filter: cssFilter,
            transition: dragging ? 'none' : 'transform 0.12s ease-out'
          }}
          className={cn(
            'max-h-[calc(100vh-148px)] max-w-[calc(100vw-40px)] select-none object-contain',
            dragging ? 'cursor-grabbing' : 'cursor-grab'
          )}
        />
      </div>

      {/* 裁剪选框与遮罩 */}
      {cropMode && imgBox && edit.crop && edit.crop.w > 0.002 && edit.crop.h > 0.002 && (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            left: imgBox.left + edit.crop.x * imgBox.width,
            top: imgBox.top + edit.crop.y * imgBox.height,
            width: edit.crop.w * imgBox.width,
            height: edit.crop.h * imgBox.height,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
            outline: '2px solid var(--c-accent)'
          }}
        />
      )}

      {/* 前后导航 */}
      {idx > 0 && (
        <button
          className="absolute left-3 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white/80 backdrop-blur hover:bg-black/70 hover:text-white"
          onClick={() => stepViewer(-1)}
          aria-label="上一张"
        >
          <ChevronLeft size={22} />
        </button>
      )}
      {idx < photos.length - 1 && (
        <button
          className="absolute right-3 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white/80 backdrop-blur hover:bg-black/70 hover:text-white"
          style={{ right: editOpen ? 260 : 12 }}
          onClick={() => stepViewer(1)}
          aria-label="下一张"
        >
          <ChevronRight size={22} />
        </button>
      )}

      {/* 缩放与全屏控制条 */}
      <div className="absolute bottom-[82px] left-3 z-20 flex items-center gap-0.5 rounded-full bg-black/45 px-1 py-0.5 text-[11px] text-white/70 backdrop-blur">
        <button
          className="grid h-7 w-7 place-items-center rounded-full hover:bg-white/15 hover:text-white"
          onClick={() => zoomTo(1 / 1.25)}
          aria-label="缩小 (-)"
          title="缩小 (-)"
        >
          <ZoomOut size={14} />
        </button>
        <button
          className="grid h-7 min-w-[46px] place-items-center rounded-full hover:bg-white/15 hover:text-white"
          onClick={resetZoom}
          aria-label="重置缩放 (0)"
          title="重置缩放 (0)"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          className="grid h-7 w-7 place-items-center rounded-full hover:bg-white/15 hover:text-white"
          onClick={() => zoomTo(1.25)}
          aria-label="放大 (+)"
          title="放大 (+)"
        >
          <ZoomIn size={14} />
        </button>
        <span className="mx-0.5 h-4 w-px bg-white/15" />
        <button
          className="grid h-7 w-7 place-items-center rounded-full hover:bg-white/15 hover:text-white"
          onClick={() => api.toggleFullscreen().catch(() => undefined)}
          aria-label="切换全屏 (F)"
          title="切换全屏 (F)"
        >
          <Maximize size={13} />
        </button>
      </div>

      {editOpen && (
        <EditPanel
          edit={edit}
          setEdit={setEdit}
          photo={photo}
          onSaved={() => undefined}
          cropMode={cropMode}
          aspect={aspect}
          setAspect={setAspect}
          onToggleCrop={toggleCrop}
        />
      )}
      {detailOpen && (
        <div
          className="absolute bottom-[74px] right-0 top-11 z-10"
          style={{ right: editOpen ? 248 : 0 }}
        >
          <DetailPanel inViewer />
        </div>
      )}

      <Filmstrip activeId={photo.id} />
    </div>
  )
}
