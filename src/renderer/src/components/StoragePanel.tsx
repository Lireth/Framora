import React, { useCallback, useEffect, useState } from 'react'
import { Eraser, Gauge, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../store'
import { cn, ConfirmDialog } from './ui'
import { formatBytes } from '../lib/format'
import type { StorageStats } from '@shared/types'

interface BucketView {
  key: string
  label: string
  bytes: number
  files: number
  color: string
}

function bucketsOf(stats: StorageStats): BucketView[] {
  return [
    { key: 'db', label: '索引库', ...stats.db, color: '#7a6fd0' },
    { key: 'thumbs', label: '缩略图', ...stats.thumbs, color: '#4f9dd0' },
    { key: 'previews', label: 'RAW 预览', ...stats.previews, color: '#e2983d' },
    { key: 'backups', label: '编辑备份', ...stats.backups, color: '#e0533d' },
    { key: 'logs', label: '日志', ...stats.logs, color: '#8a8a8a' },
    { key: 'dbBackups', label: '索引库备份', ...stats.dbBackups, color: '#5f5e5a' },
  ]
}

/** 设置页的存储占用与预算维护面板 */
export function StoragePanel({ open }: { open: boolean }): React.JSX.Element | null {
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [previewLimit, setPreviewLimit] = useState(1024)
  const [backupLimit, setBackupLimit] = useState(4096)
  const [confirm, setConfirm] = useState<'previews' | 'enforce' | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const s = await api.getStorageStats()
      setStats(s)
      setPreviewLimit(s.limits.previewBudgetMb)
      setBackupLimit(s.limits.backupBudgetMb)
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取存储统计失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  if (!open) return null

  const saveLimits = async (): Promise<void> => {
    setSaving(true)
    try {
      const limits = await api.setStorageLimits({
        previewBudgetMb: previewLimit,
        backupBudgetMb: backupLimit,
      })
      setPreviewLimit(limits.previewBudgetMb)
      setBackupLimit(limits.backupBudgetMb)
      useStore.getState().toast('success', '存储预算已保存，并完成一次按预算清理')
      await load()
    } catch (e) {
      useStore.getState().toast('error', e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const runCleanPreviews = async (): Promise<void> => {
    try {
      const r = await api.cleanPreviews()
      useStore
        .getState()
        .toast(
          r.deleted ? 'success' : 'info',
          r.deleted
            ? `已清空 ${r.deleted} 个 RAW 预览（释放 ${formatBytes(r.bytes)}），查看时按需重建`
            : '没有可清理的 RAW 预览'
        )
      await load()
    } catch (e) {
      useStore.getState().toast('error', e instanceof Error ? e.message : '清理失败')
    }
  }

  const runEnforce = async (): Promise<void> => {
    try {
      const r = await api.enforceStorage()
      const deleted = r.previews.deleted + r.backups.deleted
      const bytes = r.previews.bytes + r.backups.bytes
      useStore
        .getState()
        .toast(
          deleted ? 'success' : 'info',
          deleted
            ? `已清理 ${deleted} 个缓存/备份文件（释放 ${formatBytes(bytes)}）`
            : '当前占用均在预算内，无需清理'
        )
      await load()
    } catch (e) {
      useStore.getState().toast('error', e instanceof Error ? e.message : '清理失败')
    }
  }

  const buckets = stats ? bucketsOf(stats) : []
  const total = stats?.totalBytes ?? 0
  const lowDisk =
    stats !== null && stats.freeBytes !== null && stats.freeBytes < 2 * 1024 ** 3

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="font-medium">存储与维护</p>
        <button
          onClick={() => void load()}
          disabled={loading}
          title="刷新统计"
          aria-label="刷新统计"
          className="grid h-6 w-6 place-items-center rounded text-ink3 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <p className="text-[11px] text-red-400">{error}</p>}

      {stats && (
        <>
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-line">
            {buckets.map((b) =>
              b.bytes > 0 && total > 0 ? (
                <div
                  key={b.key}
                  style={{ width: `${(b.bytes / total) * 100}%`, background: b.color }}
                  title={`${b.label} ${formatBytes(b.bytes)}`}
                />
              ) : null
            )}
          </div>

          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="text-[12px] text-ink2">
              总占用 <b className="text-ink">{formatBytes(total)}</b>
            </span>
            <span className={cn('text-[11px]', lowDisk ? 'text-red-400' : 'text-ink3')}>
              {stats.freeBytes === null
                ? '可用空间未知'
                : `磁盘可用 ${formatBytes(stats.freeBytes)}`}
            </span>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
            {buckets.map((b) => (
              <div
                key={b.key}
                className="flex items-center justify-between gap-2 text-[11.5px]"
              >
                <span className="flex min-w-0 items-center gap-1.5 text-ink3">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: b.color }}
                  />
                  <span className="truncate">{b.label}</span>
                </span>
                <span className="shrink-0 text-ink2">{formatBytes(b.bytes)}</span>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[10.5px] text-ink3">
            缩略图 {stats.thumbs.files} · RAW 预览 {stats.previews.files} · 编辑备份{' '}
            {stats.backups.files} · 索引备份 {stats.dbBackups.files}
          </p>

          <div className="mt-3 space-y-2 rounded-lg border border-line bg-panel px-2.5 py-2">
            <div className="flex items-center justify-between gap-3 text-[12px]">
              <span className="text-ink2">RAW 预览缓存上限</span>
              <span className="flex shrink-0 items-center gap-1">
                <input
                  type="number"
                  min={0}
                  step={128}
                  value={previewLimit}
                  onChange={(e) => setPreviewLimit(Math.max(0, Number(e.target.value) || 0))}
                  className="h-7 w-[78px] rounded-md border border-line bg-app px-2 text-right text-[12px] outline-none focus:border-[var(--c-accent)]"
                  aria-label="RAW 预览缓存上限（MB）"
                />
                <span className="text-[11px] text-ink3">MB</span>
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 text-[12px]">
              <span className="text-ink2">编辑备份上限</span>
              <span className="flex shrink-0 items-center gap-1">
                <input
                  type="number"
                  min={0}
                  step={256}
                  value={backupLimit}
                  onChange={(e) => setBackupLimit(Math.max(0, Number(e.target.value) || 0))}
                  className="h-7 w-[78px] rounded-md border border-line bg-app px-2 text-right text-[12px] outline-none focus:border-[var(--c-accent)]"
                  aria-label="编辑备份上限（MB）"
                />
                <span className="text-[11px] text-ink3">MB</span>
              </span>
            </div>
            <p className="text-[10.5px] leading-relaxed text-ink3">
              0 = 不限制。超限时优先清理最旧的 RAW 预览与较早的备份历史；每张编辑过的照片至少保留最近一份。
            </p>
            <div className="flex justify-end">
              <button
                onClick={() => void saveLimits()}
                disabled={saving}
                className="rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
              >
                {saving ? '保存中…' : '保存预算'}
              </button>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={() => setConfirm('enforce')}
              className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink2 transition-colors hover:bg-hover hover:text-ink"
            >
              <Gauge size={12} /> 按预算清理
            </button>
            <button
              onClick={() => setConfirm('previews')}
              className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink2 transition-colors hover:bg-hover hover:text-ink"
            >
              <Eraser size={12} /> 清空 RAW 预览
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'previews' ? '清空 RAW 预览缓存' : '按预算清理'}
        message={
          confirm === 'previews'
            ? `将删除 ${stats?.previews.files ?? 0} 个 RAW 预览（${formatBytes(stats?.previews.bytes ?? 0)}）。照片文件不受影响，再次查看或导出时按需重建。`
            : '将按预算清理最旧的 RAW 预览与较早的编辑备份历史；每张照片至少保留最近一份备份。照片文件不受影响。'
        }
        confirmText={confirm === 'previews' ? '清空预览' : '开始清理'}
        danger={confirm === 'previews'}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm
          setConfirm(null)
          if (action === 'previews') void runCleanPreviews()
          else if (action === 'enforce') void runEnforce()
        }}
      />
    </div>
  )
}
