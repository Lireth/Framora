import React, { useEffect, useState } from 'react'
import {
  Database,
  Download,
  Eraser,
  FileClock,
  FileWarning,
  HardDrive,
  Images,
  Monitor,
  Moon,
  Sun,
  Upload
} from 'lucide-react'
import { useStore } from '../store'
import { api, onEvent } from '../lib/api'
import { cn, ConfirmDialog, Modal, PrimaryButton } from './ui'
import { StoragePanel } from './StoragePanel'
import type { UpdateState } from '@shared/types'

/** 更新流程 UI 状态机（主进程事件流驱动） */
type UpdateUi =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'uptodate' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

function mapUpdateState(s: UpdateState): UpdateUi {
  switch (s.phase) {
    case 'available':
      return { kind: 'available', version: s.version ?? '' }
    case 'up-to-date':
      return { kind: 'uptodate' }
    case 'downloading':
      return { kind: 'downloading', percent: s.percent ?? 0 }
    case 'downloaded':
      return { kind: 'downloaded', version: s.version ?? '' }
    case 'error':
      return { kind: 'error', message: s.message ?? '' }
    default:
      return { kind: 'idle' }
  }
}

const UPD_BTN_NEUTRAL =
  'rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink2 transition-colors hover:bg-hover hover:text-ink'
const UPD_BTN_ACCENT =
  'rounded-md bg-[var(--c-accent)] px-2.5 py-1 text-[11.5px] font-medium text-[#171310] transition-colors hover:bg-[var(--c-accent-hover)]'

export function SettingsModal(): React.JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const appVersion = useStore((s) => s.appVersion)
  const [rebuildOpen, setRebuildOpen] = useState(false)
  const [clearBackupsOpen, setClearBackupsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [phashThreshold, setPhashThreshold] = useState(6)
  const [upd, setUpd] = useState<UpdateUi>({ kind: 'idle' })

  // 更新流程事件 → UI 状态机
  useEffect(() => onEvent('evt:update', (d) => setUpd(mapUpdateState(d as UpdateState))), [])

  // 打开设置时恢复进行中的更新状态（如下载进度）与相似度阈值
  useEffect(() => {
    if (!open) return
    api
      .getUpdateState()
      .then((s) => setUpd(mapUpdateState(s)))
      .catch(() => undefined)
    api
      .getSetting('phashThreshold')
      .then((raw) => {
        const n = raw === null || raw === '' ? NaN : Number(raw)
        setPhashThreshold(Number.isFinite(n) && n >= 2 && n <= 12 ? Math.floor(n) : 6)
      })
      .catch(() => undefined)
  }, [open])

  const applyPhashThreshold = async (v: number): Promise<void> => {
    setPhashThreshold(v)
    try {
      await api.setPhashThreshold(v)
      // 当前正在浏览重复照片视图时立即按新阈值重查
      if (useStore.getState().scope === 'duplicates') void useStore.getState().refreshPhotos()
    } catch {
      useStore.getState().toast('error', '保存相似度设置失败')
    }
  }

  const runCheck = async (): Promise<void> => {
    setUpd({ kind: 'checking' })
    try {
      const r = await api.checkForUpdate()
      if (r.status === 'dev') {
        setUpd({ kind: 'idle' })
        useStore.getState().toast('info', '开发模式不支持检查更新')
      } else if (r.status === 'available' && r.version) {
        setUpd({ kind: 'available', version: r.version })
      } else if (r.status === 'up-to-date') {
        setUpd({ kind: 'uptodate' })
      } else {
        setUpd({ kind: 'error', message: r.error ?? '检查失败' })
      }
    } catch (e) {
      setUpd({ kind: 'error', message: e instanceof Error ? e.message : '检查失败' })
    }
  }

  const runDownload = async (): Promise<void> => {
    try {
      // 成功/进度由 evt:update 事件流推进到 downloaded
      await api.downloadUpdate()
    } catch (e) {
      setUpd({ kind: 'error', message: e instanceof Error ? e.message : '下载失败' })
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="设置"
        width={500}
        footer={<PrimaryButton onClick={() => setOpen(false)}>完成</PrimaryButton>}
      >
        <div className="space-y-5 text-[13px]">
          <div>
            <p className="mb-2 font-medium">外观</p>
            <div className="flex gap-2">
              {(
                [
                  ['dark', '深色', <Moon key="d" size={14} />],
                  ['light', '浅色', <Sun key="l" size={14} />],
                  ['system', '跟随系统', <Monitor key="s" size={14} />]
                ] as const
              ).map(([v, label, icon]) => (
                <button
                  key={v}
                  onClick={() => setTheme(v)}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-lg border py-2.5 text-[12.5px] transition-colors',
                    theme === v
                      ? 'border-[var(--c-accent)] bg-accent-soft text-accent'
                      : 'border-line text-ink2 hover:bg-hover hover:text-ink'
                  )}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 font-medium">相似照片</p>
            <div className="flex gap-2">
              {(
                [
                  [4, '严格'],
                  [6, '标准'],
                  [8, '宽松']
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => void applyPhashThreshold(v)}
                  className={cn(
                    'flex-1 rounded-lg border py-2 text-[12.5px] transition-colors',
                    phashThreshold === v
                      ? 'border-[var(--c-accent)] bg-accent-soft text-accent'
                      : 'border-line text-ink2 hover:bg-hover hover:text-ink'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-ink3">
              「重复照片」视图把感知哈希距离 ≤ 阈值的照片聚为一组：严格更少误报，宽松覆盖更多相似变体。
            </p>
          </div>

          <StoragePanel open={open} />

          <div>
            <p className="mb-2 font-medium">缓存维护</p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setRebuildOpen(true)}
                className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink2 hover:bg-hover hover:text-ink"
              >
                <Images size={13} /> 重建全部缩略图
              </button>
              <button
                onClick={() =>
                  api
                    .cleanupOrphanThumbs()
                    .then((n) =>
                      useStore
                        .getState()
                        .toast(n ? 'success' : 'info', n ? `已清理 ${n} 个孤儿缩略图` : '没有需要清理的缩略图')
                    )
                    .catch(() => useStore.getState().toast('error', '清理失败'))
                }
                className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink2 hover:bg-hover hover:text-ink"
              >
                <Eraser size={13} /> 清理孤儿缩略图
              </button>
              <button
                onClick={() => api.openThumbsDir().catch(() => undefined)}
                className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink2 hover:bg-hover hover:text-ink"
              >
                <HardDrive size={13} /> 打开缩略图目录
              </button>
              <button
                onClick={() => api.openDataDir().catch(() => undefined)}
                className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink2 hover:bg-hover hover:text-ink"
              >
                <Database size={13} /> 打开数据目录
              </button>
              <button
                onClick={() => api.openLogsDir().catch(() => undefined)}
                className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink2 hover:bg-hover hover:text-ink"
              >
                <FileWarning size={13} /> 打开日志目录
              </button>
              <button
                onClick={() => setClearBackupsOpen(true)}
                className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink2 hover:bg-hover hover:text-ink"
              >
                <FileClock size={13} /> 清理编辑备份
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-ink3">
              数据（索引库与缩略图）保存在应用数据目录，删除数据目录即完全重置。
              编辑备份每张照片自动保留最近 5 份。
            </p>
          </div>

          <div>
            <p className="mb-2 font-medium">备份与迁移</p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() =>
                  api
                    .exportBackup()
                    .then((p) =>
                      p
                        ? useStore.getState().toast('success', `已导出备份：${p}`)
                        : undefined
                    )
                    .catch((e) =>
                      useStore.getState().toast('error', e instanceof Error ? e.message : '导出失败')
                    )
                }
                disabled={importing}
                className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink2 hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download size={13} /> 导出索引库备份
              </button>
              <button
                onClick={() => setImportOpen(true)}
                disabled={importing}
                className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink2 hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Upload size={13} /> {importing ? '正在校验并导入…' : '从备份导入索引库'}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-ink3">
              备份仅含索引与整理成果（评分 / 标签 / 相册），不含照片文件；换机时配合照片文件一起迁移。
              导入会先校验版本与完整性，再原子替换当前索引库；原库自动保留为 .pre-import 文件。
            </p>
            {importing && (
              <p className="mt-1 text-[11px] text-accent">
                正在校验备份完整性并切换索引库，请勿关闭应用…
              </p>
            )}
          </div>

          <div>
            <p className="mb-2 font-medium">关于</p>
            <div className="rounded-lg border border-line bg-panel px-3 py-2.5 text-[12px] leading-relaxed text-ink2">
              <p className="font-semibold text-ink">拾帧 Framora {appVersion || ''}</p>
              <p>Windows 本地写真照片管理 · Electron + React + SQLite + sharp</p>
              <p className="text-[11px] text-ink3">
                所有数据均保存在本机，不主动联网；仅在手动检查更新时访问 GitHub。
              </p>
              <div className="mt-2.5 flex min-h-[26px] flex-wrap items-center gap-2">
                {(upd.kind === 'idle' || upd.kind === 'uptodate' || upd.kind === 'error') && (
                  <>
                    <button className={UPD_BTN_NEUTRAL} onClick={() => void runCheck()}>
                      检查更新
                    </button>
                    {upd.kind === 'uptodate' && (
                      <span className="text-[11px] text-ink3">已是最新版本</span>
                    )}
                    {upd.kind === 'error' && (
                      <span className="truncate text-[11px] text-red-400" title={upd.message}>
                        检查失败：{upd.message}
                      </span>
                    )}
                  </>
                )}
                {upd.kind === 'checking' && (
                  <span className="text-[11px] text-ink3">正在检查…</span>
                )}
                {upd.kind === 'available' && (
                  <>
                    <span className="text-[11.5px] text-ink2">发现新版本 v{upd.version}</span>
                    <button className={UPD_BTN_ACCENT} onClick={() => void runDownload()}>
                      下载更新
                    </button>
                  </>
                )}
                {upd.kind === 'downloading' && (
                  <>
                    <div className="h-1 min-w-[80px] flex-1 overflow-hidden rounded bg-line">
                      <div
                        className="h-full bg-[var(--c-accent)] transition-all"
                        style={{ width: `${upd.percent}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-ink3">{upd.percent}%</span>
                    <button
                      className={UPD_BTN_NEUTRAL}
                      onClick={() => void api.cancelUpdateDownload().catch(() => undefined)}
                    >
                      取消
                    </button>
                  </>
                )}
                {upd.kind === 'downloaded' && (
                  <>
                    <span className="text-[11.5px] text-ink2">更新已就绪 v{upd.version}</span>
                    <button
                      className={UPD_BTN_ACCENT}
                      onClick={() => void api.installUpdate().catch(() => undefined)}
                    >
                      安装并重启
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={rebuildOpen}
        title="重建缩略图缓存"
        message="将重新生成资料库中全部照片的缩略图，照片文件本身不受影响。继续吗？"
        confirmText="开始重建"
        onClose={() => setRebuildOpen(false)}
        onConfirm={() => {
          api
            .rebuildThumbs()
            .then(() => useStore.getState().toast('success', '已开始重建缩略图'))
            .catch(() => useStore.getState().toast('error', '重建失败'))
        }}
      />

      <ConfirmDialog
        open={clearBackupsOpen}
        title="清理编辑备份"
        message="将删除全部编辑备份文件，清理后将无法撤销已保存的编辑，照片文件本身不受影响。继续吗？"
        confirmText="清理备份"
        danger
        onClose={() => setClearBackupsOpen(false)}
        onConfirm={() => {
          api
            .clearBackups()
            .then((n) => useStore.getState().toast('success', `已清理 ${n} 个备份文件`))
            .catch(() => useStore.getState().toast('error', '清理失败'))
        }}
      />

      <ConfirmDialog
        open={importOpen}
        title="从备份导入索引库"
        message="将先校验备份的 schema 版本与完整性，通过后用其替换当前索引库（评分 / 标签 / 相册等整理成果）。照片文件不受影响，原库会自动保留；若备份中的照片路径与本机不一致，需重新导入对应文件夹。继续吗？"
        confirmText="选择备份文件"
        danger
        onClose={() => setImportOpen(false)}
        onConfirm={() => {
          setImportOpen(false)
          setImporting(true)
          api
            .importBackup()
            .then((r) => {
              if (!r) return
              useStore
                .getState()
                .toast('success', `导入完成：${r.photos} 张照片${r.rebuiltThumbs ? `，补建 ${r.rebuiltThumbs} 个缩略图` : ''}`)
              void useStore.getState().refreshLibrary()
              void useStore.getState().refreshPhotos()
            })
            .catch((e) =>
              useStore.getState().toast('error', e instanceof Error ? e.message : '导入失败')
            )
            .finally(() => setImporting(false))
        }}
      />
    </>
  )
}
