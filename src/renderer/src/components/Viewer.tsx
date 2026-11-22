import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  FlipHorizontal2,
  Keyboard,
  Maximize,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { photoIndexOf, useStore } from '../store'
import { api } from '../lib/api'
import { displayUrl, formatBytes } from '../lib/format'
import { cn, IconButton } from './ui'
import { DetailPanel } from './DetailPanel'
import { Filmstrip } from './viewer/Filmstrip'
import { EditPanel } from './viewer/EditPanel'
import { ASPECT_RATIOS, EDIT_RESET, type Aspect, type EditState } from './viewer/types'

const MIN_ZOOM = 0.15
const MAX_ZOOM = 8

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function Viewer(): React.JSX.Element {
  const photos = useStore((s) => s.photos)
  const activeId = useStore((s) => s.activeId)
  const stepViewer = useStore((s) => s.stepViewer)
  const closeViewer = useStore((s) => s.closeViewer)
  const detailOpen = useStore((s) => s.detailOpen)
  const toggleDetail = useStore((s) => s.toggleDetail)
  const slideshowOn = useStore((s) => s.slideshowOn)
  const slideshowPaused = useStore((s) => s.slideshowPaused)

  /* id → 下标：使用 store 的共享 WeakMap 映射（数组替换时重建一次，O(1) 查询），
     此前每次 photos 变化都在本组件与 Filmstrip 各重建一张 Map + 每帧线性扫描 */
  const activeIdx = photoIndexOf(photos, activeId)
  // activeId 失效（过滤刷新移除等）时回退首张，与既有行为一致
  const photo = activeIdx >= 0 ? photos[activeIdx] : photos[0]
  /** 显示照片的真实下标（回退首张时为 0），供页码与前后导航判定 */
  const idx = photo ? Math.max(0, activeIdx) : -1

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

  // 幻灯片轮播（FEAT-05）：3s 间隔循环步进；编辑/裁剪/暂停期间不推进
  useEffect(() => {
    if (!slideshowOn || slideshowPaused || editOpen || cropMode) return
    const t = setInterval(() => useStore.getState().slideshowNext(), 3000)
    return () => clearInterval(t)
  }, [slideshowOn, slideshowPaused, editOpen, cropMode])

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
    const idx = photoIndexOf(photos, photo.id)
    for (const d of [-1, 1, -2, 2]) {
      const p = photos[idx + d]
      if (!p || p.missing) continue
      const img = new Image()
      img.src = displayUrl(p)
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

  /* 查看器快捷键：+/− 缩放、0 复位、R/r 旋转预览、F 全屏 */
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
      } else if (k === 'r' || k === 'R') {
        e.preventDefault()
        // 仅旋转预览（与顶栏旋转按钮一致），保存修改时才写盘
        setEdit((prev) => ({ ...prev, rotateDelta: prev.rotateDelta + (k === 'r' ? 90 : -90) }))
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
        <IconButton
          icon={<Play size={15} />}
          label="幻灯片放映（3s 循环）"
          active={slideshowOn}
          onClick={() => useStore.getState().startSlideshow()}
        />
        {slideshowOn && (
          <IconButton
            icon={<Pause size={15} />}
            label={slideshowPaused ? "继续放映 (空格)" : "暂停放映 (空格)"}
            active={!slideshowPaused}
            onClick={() => useStore.getState().toggleSlideshowPause()}
          />
        )}
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
          src={displayUrl(photo)}
          alt={photo.name}
          draggable
          onDragStart={(e) => {
            e.preventDefault()
            // 放大状态下拖拽留给平移，仅在原始视图下把原文件拖出到资源管理器；
            // 同时登记拖拽会话，使该拖拽也可放回侧边栏相册/标签
            if (zoom !== 1) return
            useStore.getState().setDraggingPhotos([photo.id], [photo.path])
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
        <button
          className="grid h-7 w-7 place-items-center rounded-full hover:bg-white/15 hover:text-white"
          onClick={() => useStore.getState().setHelpOpen(true)}
          aria-label="快捷键帮助 (?)"
          title="快捷键帮助 (?)"
        >
          <Keyboard size={13} />
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

      <Filmstrip activeId={photo.id} activeIdx={idx} />
    </div>
  )
}
