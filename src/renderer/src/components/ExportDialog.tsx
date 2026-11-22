import React, { useEffect, useState } from 'react'
import { FolderOpen, Loader2, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { parentDir } from '../lib/format'
import { deletePhotosAction } from '../lib/actions'
import { ConfirmDialog, GhostButton, Modal, PrimaryButton } from './ui'
import type { EditPreset, WatermarkOptions } from '@shared/types'
import { cn } from './ui'

type Fmt = 'original' | 'jpeg' | 'webp' | 'png' | 'avif'

export function ExportDialog(): React.JSX.Element | null {
  const open = useStore((s) => s.exportOpen)
  const close = useStore((s) => s.closeExport)
  const exportIds = useStore((s) => s.exportIds)
  const exportMode = useStore((s) => s.exportMode)
  const selection = useStore((s) => s.selection)
  const exportProgress = useStore((s) => s.exportProgress)
  const setExportProgress = useStore((s) => s.setExportProgress)
  const isConvert = exportMode === 'convert'

  const [dir, setDir] = useState('')
  const [fmt, setFmt] = useState<Fmt>('jpeg')
  const [maxSide, setMaxSide] = useState(0)
  const [quality, setQuality] = useState(92)
  const [nameTemplate, setNameTemplate] = useState('{name}')
  const [presets, setPresets] = useState<EditPreset[]>([])
  const [presetId, setPresetId] = useState('')
  const [wmText, setWmText] = useState('')
  const [wmPos, setWmPos] = useState<'tl' | 'tr' | 'bl' | 'br' | 'center' | 'tile'>('br')
  const [wmSize, setWmSize] = useState(36)
  const [wmOpacity, setWmOpacity] = useState(60)
  const [busy, setBusy] = useState(false)
  /** 删除当前选中预设的确认框（FEAT-19：此前预设只能存不能删） */
  const [delPresetOpen, setDelPresetOpen] = useState(false)

  useEffect(() => {
    if (open) {
      setDir('')
      setFmt('jpeg')
      setMaxSide(0)
      setQuality(92)
      setNameTemplate('{name}')
      setPresetId('')
      api
        .listPresets()
        .then(setPresets)
        .catch(() => setPresets([]))
    }
  }, [open])

  if (!open) return null

  const ids = exportIds ?? [...selection]

  const pick = async (): Promise<void> => {
    const d = await api.pickExportDir()
    if (d) setDir(d)
  }

  /** 水印参数组装：文本为空则不启用（FEAT-11） */
  const buildWatermark = (): WatermarkOptions | undefined =>
    wmText.trim()
      ? { text: wmText.trim().slice(0, 60), position: wmPos, fontSize: wmSize, opacity: wmOpacity }
      : undefined
  const run = async (): Promise<void> => {
    // 库内转换（FEAT-06）：逐张导出到源文件夹（复用导出管线与防覆盖命名），
    // 全部完成后源文件一次性移入应用内回收站（可还原）
    if (isConvert) {
      setBusy(true)
      const converted: number[] = []
      let failed = 0
      let cancelled = false
      try {
        for (const id of ids) {
          const rec = await api.getPhoto(id).catch(() => null)
          if (!rec || rec.missing) {
            failed++
            continue
          }
          const r = await api.exportPhotos([id], parentDir(rec.path), {
            format: fmt,
            quality,
            maxSide: maxSide || undefined,
            adjust: presets.find((x) => x.id === presetId)?.adjust,
            watermark: buildWatermark(),
          })
          if (r.cancelled) {
            cancelled = true
            break
          }
          if (r.exported > 0) converted.push(id)
          else failed++
        }
        // silent：转换完成的总提示已含「源已移入回收站」（OPT-49），
        // 不再叠加删除动作自身的 toast
        if (converted.length) await deletePhotosAction(converted, { silent: true })
        else useStore.getState().refreshPhotos()
        useStore
          .getState()
          .toast(
            cancelled ? 'info' : failed ? 'info' : 'success',
            cancelled
              ? `已停止转换：完成 ${converted.length} 张（已转换的源已移入回收站）`
              : `转换完成：${converted.length} 张${failed ? `，失败 ${failed} 张` : ''}（源已移入回收站，可还原）`,
          )
        close()
      } catch (e) {
        useStore.getState().toast('error', e instanceof Error ? e.message : '转换失败')
      } finally {
        setBusy(false)
        setExportProgress(null)
      }
      return
    }
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
        nameTemplate: nameTemplate.trim() || undefined,
        adjust: presets.find((x) => x.id === presetId)?.adjust,
        watermark: buildWatermark(),
      })
      if (r.cancelled) {
        useStore
          .getState()
          .toast('info', `已停止导出：成功 ${r.exported} 张（已完成文件保留在导出目录）`)
      } else {
        useStore
          .getState()
          .toast(
            r.failed ? 'info' : 'success',
            `导出完成：成功 ${r.exported} 张${r.failed ? `，失败 ${r.failed} 张` : ''} → ${dir}`
          )
        close()
      }
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
    <>
      <Modal
      open={open}
      onClose={close}
        title={isConvert ? `转换 ${ids.length} 张照片的格式` : `导出 ${ids.length} 张照片`}
      width={440}
      footer={
        <>
          {busy ? (
            <GhostButton onClick={() => void api.cancelExport().catch(() => undefined)}>
              停止
            </GhostButton>
          ) : (
            <GhostButton onClick={close}>取消</GhostButton>
          )}
          <PrimaryButton onClick={run} disabled={busy || !dir}>
            <span className="flex items-center gap-1.5">
              {busy && <Loader2 size={13} className="animate-spin" />}
              {busy && exportProgress
                ? `${isConvert ? '转换' : '导出'}中 ${exportProgress.done}/${exportProgress.total}`
                : isConvert
                  ? '开始转换'
                  : '开始导出'}
            </span>
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-4 text-[13px]">
        {isConvert && (
          <p className="rounded-md border border-line bg-panel px-3 py-2 text-[11.5px] leading-relaxed text-ink2">
            库内转换：新文件输出到照片所在文件夹（重名自动改名），完成后源文件移入应用内回收站，可随时还原。
          </p>
        )}
        {!isConvert && (
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
        )}

        <div>
          <p className="mb-1.5 text-[12px] text-ink3">格式</p>
          <div className="flex flex-wrap gap-1.5">
            {fmtOptions.filter(([v]) => !isConvert || v !== 'original').map(([v, label]) => (
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

        {presets.length > 0 && (
          <div>
            <p className="mb-1.5 text-[12px] text-ink3">编辑预设（可选，写导出副本不改原图）</p>
            <div className="flex gap-2">
              <select
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
                className="h-8 min-w-0 flex-1 rounded-md border border-line bg-panel px-2 text-xs outline-none"
              >
                <option value="">不应用</option>
                {presets.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <GhostButton
                onClick={() => setDelPresetOpen(true)}
                disabled={!presetId}
                title="删除当前选中的预设"
                ariaLabel="删除当前选中的预设"
              >
                <Trash2 size={13} />
              </GhostButton>
            </div>
          </div>
        )}

        <div>
          <p className="mb-1.5 text-[12px] text-ink3">文字水印（可选）</p>
          <input
            value={wmText}
            onChange={(e) => setWmText(e.target.value)}
            placeholder="水印文字，留空则不启用"
            maxLength={60}
            className="h-8 w-full rounded-md border border-line bg-panel px-2.5 text-xs outline-none focus:border-[var(--c-accent)]"
          />
          {wmText.trim() && (
            <div className="mt-2 space-y-2">
              <div className="flex gap-1.5">
                {(
                  [
                    ['tl', '左上'],
                    ['tr', '右上'],
                    ['bl', '左下'],
                    ['br', '右下'],
                    ['center', '居中'],
                    ['tile', '平铺']
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => setWmPos(v)}
                    className={cn(
                      'flex-1 rounded-md border px-1 py-1 text-[11px] transition-colors',
                      wmPos === v
                        ? 'border-[var(--c-accent)] bg-accent-soft text-accent'
                        : 'border-line text-ink2 hover:bg-hover hover:text-ink'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px] text-ink3">
                  <span>字号</span>
                  <span>{wmSize}px</span>
                </div>
                <input
                  type="range"
                  min={12}
                  max={200}
                  value={wmSize}
                  onChange={(e) => setWmSize(Number(e.target.value))}
                  className="w-full"
                />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px] text-ink3">
                  <span>不透明度</span>
                  <span>{wmOpacity}%</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={wmOpacity}
                  onChange={(e) => setWmOpacity(Number(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          )}
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

        {!isConvert && (
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
        )}

        <p className="text-[11px] leading-relaxed text-ink3">
          重名文件自动追加序号，不会覆盖已有文件；旋转方向与星级等应用内编辑不会写入导出副本。
        </p>
      </div>
      </Modal>

      <ConfirmDialog
        open={delPresetOpen}
        title="删除编辑预设"
        message={`将删除预设「${presets.find((x) => x.id === presetId)?.name ?? ''}」。该操作不可撤销，确定继续吗？`}
        confirmText="删除预设"
        danger
        onClose={() => setDelPresetOpen(false)}
        onConfirm={() => {
          const id = presetId
          setDelPresetOpen(false)
          if (!id) return
          api
            .deletePreset(id)
            .then((list) => {
              setPresets(list)
              // 被删预设可能正被选中，回退到「不应用」
              setPresetId('')
              useStore.getState().toast('success', '预设已删除')
            })
            .catch(() => useStore.getState().toast('error', '删除预设失败'))
        }}
      />
    </>
  )
}
