/**
 * 胶片条（自 Viewer.tsx 拆出，OPT-36）：横向虚拟化快速切换。
 */
import React, { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useStore } from '../../store'
import { thumbUrl } from '../../lib/format'
import { cn } from '../ui'

const STRIP_ITEM = 56
const STRIP_GAP = 6

export function Filmstrip({ activeId, activeIdx }: { activeId: number | null; activeIdx: number }): React.JSX.Element {
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
    if (activeIdx < 0) return
    virtualizer.scrollToIndex(activeIdx, { align: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx])

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
              aria-label={`第 ${vi.index + 1} 张：${p.name}`}
              aria-current={p.id === activeId ? 'true' : undefined}
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
