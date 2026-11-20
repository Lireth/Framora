import React, { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { cn, useOutsideClose } from './ui'

/**
 * 标签选择器：
 * - photoIds.length === 1 时为「设置该照片的标签集合」
 * - photoIds.length > 1 时为批量「添加/移除」
 */
export function TagPicker({
  photoIds,
  initialSelected,
  onClose,
  title
}: {
  photoIds: number[]
  initialSelected?: Set<number>
  onClose: () => void
  title?: string
}): React.JSX.Element {
  const tags = useStore((s) => s.tags)
  const refreshLibrary = useStore((s) => s.refreshLibrary)
  const refreshPhotos = useStore((s) => s.refreshPhotos)
  const [selected, setSelected] = useState<Set<number>>(initialSelected ?? new Set())
  const [newName, setNewName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(ref, onClose)

  useEffect(() => {
    // 单张照片时读取其当前标签
    if (photoIds.length === 1 && !initialSelected) {
      api
        .getPhoto(photoIds[0])
        .then((r) => setSelected(new Set(r.tags.map((t) => t.id))))
        .catch(() => undefined)
    }
  }, [photoIds, initialSelected])

  const toggle = async (tagId: number): Promise<void> => {
    const next = new Set(selected)
    const adding = !next.has(tagId)
    if (adding) next.add(tagId)
    else next.delete(tagId)
    setSelected(next)
    try {
      if (photoIds.length === 1) {
        await api.setTags(photoIds[0], [...next])
      } else {
        await api.batchTags(photoIds, adding ? [tagId] : [], adding ? [] : [tagId])
      }
      refreshLibrary()
      refreshPhotos()
    } catch (e) {
      useStore.getState().toast('error', e instanceof Error ? e.message : '标签操作失败')
    }
  }

  const create = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    try {
      const t = await api.createTag(name, null)
      setNewName('')
      refreshLibrary()
      setSelected((prev) => {
        const next = new Set(prev)
        next.add(t.id)
        return next
      })
      if (photoIds.length === 1) {
        await api.setTags(photoIds[0], [...selected, t.id])
        refreshPhotos()
      } else {
        await api.batchTags(photoIds, [t.id], [])
        refreshPhotos()
      }
    } catch (e) {
      useStore.getState().toast('error', e instanceof Error ? e.message : '创建标签失败')
    }
  }

  return (
    <div
      ref={ref}
      className="absolute left-1/2 top-1/2 z-[60] w-[240px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-raised p-3 shadow-2xl animate-popIn"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12.5px] font-semibold">
          {title ?? (photoIds.length > 1 ? `为 ${photoIds.length} 张照片添加标签` : '照片标签')}
        </span>
        <button className="text-ink3 hover:text-ink" onClick={onClose} aria-label="关闭">
          <X size={13} />
        </button>
      </div>
      <div className="max-h-[200px] overflow-y-auto">
        {tags.length === 0 && (
          <p className="px-1 py-2 text-[11.5px] text-ink3">还没有标签，先在下方创建一个</p>
        )}
        <div className="flex flex-wrap gap-1.5 py-1">
          {tags.map((t) => (
            <button
              key={t.id}
              onClick={() => toggle(t.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors',
                selected.has(t.id)
                  ? 'border-[var(--c-accent)] bg-accent-soft text-accent'
                  : 'border-line text-ink2 hover:bg-hover hover:text-ink'
              )}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: t.color ?? 'var(--c-accent)' }}
              />
              {t.name}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5 border-t border-line pt-2.5">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create()
          }}
          placeholder="新建标签…"
          className="h-7 flex-1 rounded-md border border-line bg-panel px-2 text-[12px] outline-none focus:border-[var(--c-accent)]"
        />
        <button
          onClick={create}
          className="grid h-7 w-7 place-items-center rounded-md border border-line text-ink2 hover:bg-hover hover:text-ink"
          aria-label="创建标签"
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  )
}
