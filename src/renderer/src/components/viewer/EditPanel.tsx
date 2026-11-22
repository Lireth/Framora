/**
 * 编辑面板（自 Viewer.tsx 拆出，OPT-36）：亮度/对比度等实时调整、裁剪入口、
 * 编辑历史与备份恢复、保存写回。
 */
import React, { useState } from 'react'
import {
  Crop,
  ExternalLink,
  FlipHorizontal2,
  FlipVertical2,
  History,
  Loader2,
  RotateCcw,
  RotateCw,
  Save,
  Undo2
} from 'lucide-react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { formatBytes, formatDateTime } from '../../lib/format'
import { cn, PrimaryButton, GhostButton } from '../ui'
import { ASPECT_RATIOS, EDIT_RESET, type Aspect, type EditState } from './types'
import type { BackupInfo, PhotoLite } from '@shared/types'

export function EditPanel({
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

  // 编辑历史：备份按时间倒序，可恢复到任意一份
  const [historyOpen, setHistoryOpen] = useState(false)
  const [backups, setBackups] = useState<BackupInfo[] | null>(null)

  const toggleHistory = async (): Promise<void> => {
    const next = !historyOpen
    setHistoryOpen(next)
    if (next) {
      try {
        setBackups(await api.listBackups(photo.id))
      } catch {
        setBackups([])
      }
    }
  }

  const restoreTo = async (b: BackupInfo): Promise<void> => {
    try {
      await api.revertEdits(photo.id, b.name)
      useStore.getState().toast('success', `已恢复到 ${formatDateTime(b.ts)} 保存前的状态`)
      setEdit(EDIT_RESET)
      useStore.getState().patchPhoto(photo.id, { thumb_status: 0 })
      onSaved()
    } catch (e) {
      useStore.getState().toast('error', e instanceof Error ? e.message : '恢复失败')
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
        <button
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-white/15 text-[12px] text-white/70 hover:bg-white/10"
          onClick={() => void toggleHistory()}
        >
          <History size={13} /> 编辑历史…
        </button>
        {historyOpen && (
          <div className="rounded-md border border-white/10 bg-black/30 p-1.5">
            {backups === null ? (
              <p className="px-1 py-1.5 text-[11px] text-white/40">加载中…</p>
            ) : backups.length === 0 ? (
              <p className="px-1 py-1.5 text-[11px] text-white/40">暂无历史备份（每张照片保留最近 5 份）</p>
            ) : (
              backups.map((b) => (
                <div key={b.name} className="flex items-center gap-1.5 px-1 py-1 text-[11px]">
                  <span className="flex-1 truncate text-white/70">{formatDateTime(b.ts)}</span>
                  <span className="text-white/35">{formatBytes(b.size)}</span>
                  <button
                    className="rounded border border-white/15 px-1.5 py-0.5 text-white/70 hover:bg-white/10"
                    onClick={() => void restoreTo(b)}
                  >
                    恢复
                  </button>
                </div>
              ))
            )}
          </div>
        )}
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
