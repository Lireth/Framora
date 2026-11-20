import React, { useEffect, useState } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { GhostButton, Modal, PrimaryButton } from './ui'
import { cn } from './ui'

type Fmt = 'original' | 'jpeg' | 'webp' | 'png' | 'avif'

export function ExportDialog(): React.JSX.Element | null {
  const open = useStore((s) => s.exportOpen)
  const close = useStore((s) => s.closeExport)
  const exportIds = useStore((s) => s.exportIds)
  const selection = useStore((s) => s.selection)
  const exportProgress = useStore((s) => s.exportProgress)
  const setExportProgress = useStore((s) => s.setExportProgress)

  const [dir, setDir] = useState('')
  const [fmt, setFmt] = useState<Fmt>('original')
  const [maxSide, setMaxSide] = useState(0)
  const [quality, setQuality] = useState(92)
  const [nameTemplate, setNameTemplate] = useState('{name}')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setDir('')
      setFmt('original')
      setMaxSide(0)
      setQuality(92)
      setNameTemplate('{name}')
    }
  }, [open])

  if (!open) return null

  const ids = exportIds ?? [...selection]

  const pick = async (): Promise<void> => {
    const d = await api.pickExportDir()
    if (d) setDir(d)
  }

  const run = async (): Promise<void> => {
    if (!dir) {
      useStore.getState().toast('error', '请先选择导出位置')
      return
    }
    setBusy(true)
    try {
      const r = await api.exportPhotos(ids, dir, {
        format: fmt,
        maxSide: maxSide || undefined,
        quality,
        nameTemplate: nameTemplate.trim() || undefined
      })
      useStore
        .getState()
        .toast(
          r.failed ? 'info' : 'success',
          `导出完成：成功 ${r.exported} 张${r.failed ? `，失败 ${r.failed} 张` : ''} → ${dir}`
        )
      close()
    } catch (e) {
      useStore.getState().toast('error', e instanceof Error ? e.message : '导出失败')
    } finally {
      setBusy(false)
      setExportProgress(null)
    }
  }

  const fmtOptions: [Fmt, string][] = [
    ['original', '保持原格式'],
    ['jpeg', 'JPEG'],
    ['webp', 'WebP'],
    ['png', 'PNG'],
    ['avif', 'AVIF']
  ]
  const sizeOptions: [number, string][] = [
    [0, '原始尺寸'],
    [4096, '长边 4096px'],
    [2048, '长边 2048px'],
    [1080, '长边 1080px'],
    [800, '长边 800px']
  ]

  return (
    <Modal
      open={open}
      onClose={close}
      title={`导出 ${ids.length} 张照片`}
      width={440}
      footer={
        <>
          <GhostButton onClick={close}>取消</GhostButton>
          <PrimaryButton onClick={run} disabled={busy || !dir}>
            <span className="flex items-center gap-1.5">
              {busy && <Loader2 size={13} className="animate-spin" />}
              {busy && exportProgress
                ? `导出中 ${exportProgress.done}/${exportProgress.total}`
                : '开始导出'}
            </span>
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-4 text-[13px]">
        <div>
          <p className="mb-1.5 text-[12px] text-ink3">导出位置</p>
          <div className="flex gap-2">
            <input
              value={dir}
              readOnly
              placeholder="未选择文件夹"
              className="h-8 min-w-0 flex-1 truncate rounded-md border border-line bg-panel px-2.5 text-xs text-ink2 outline-none"
            />
            <GhostButton onClick={pick}>
              <span className="flex items-center gap-1.5">
                <FolderOpen size={13} /> 选择
              </span>
            </GhostButton>
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-[12px] text-ink3">格式</p>
          <div className="flex flex-wrap gap-1.5">
            {fmtOptions.map(([v, label]) => (
              <button
                key={v}
                onClick={() => setFmt(v)}
                className={cn(
                  'rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                  fmt === v
                    ? 'border-[var(--c-accent)] bg-accent-soft text-accent'
                    : 'border-line text-ink2 hover:bg-hover hover:text-ink'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-[12px] text-ink3">尺寸</p>
          <div className="flex flex-wrap gap-1.5">
            {sizeOptions.map(([v, label]) => (
              <button
                key={v}
                onClick={() => setMaxSide(v)}
                className={cn(
                  'rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                  maxSide === v
                    ? 'border-[var(--c-accent)] bg-accent-soft text-accent'
                    : 'border-line text-ink2 hover:bg-hover hover:text-ink'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {(fmt === 'jpeg' || fmt === 'webp' || fmt === 'avif') && (
          <div>
            <div className="mb-1 flex items-center justify-between text-[12px] text-ink3">
              <span>质量</span>
              <span>{quality}</span>
            </div>
            <input
              type="range"
              min={50}
              max={100}
              value={quality}
              onChange={(e) => setQuality(Number(e.target.value))}
              className="w-full"
            />
          </div>
        )}

        <div>
          <p className="mb-1.5 text-[12px] text-ink3">文件名模板</p>
          <input
            value={nameTemplate}
            onChange={(e) => setNameTemplate(e.target.value)}
            placeholder="{name}"
            className="h-8 w-full rounded-md border border-line bg-panel px-2.5 text-xs outline-none focus:border-[var(--c-accent)]"
          />
          <p className="mt-1 text-[11px] text-ink3">
            支持 {'{name}'} 原文件名、{'{date}'} 拍摄日期、{'{index}'} 三位序号，重名自动追加序号。
          </p>
        </div>

        <p className="text-[11px] leading-relaxed text-ink3">
          重名文件自动追加序号，不会覆盖已有文件；旋转方向与星级等应用内编辑不会写入导出副本。
        </p>
      </div>
    </Modal>
  )
}
