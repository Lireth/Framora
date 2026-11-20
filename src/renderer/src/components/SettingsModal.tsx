import React from 'react'
import { Database, HardDrive, Images, Moon, Sun } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { cn, ConfirmDialog, Modal, PrimaryButton } from './ui'
import { useState } from 'react'

export function SettingsModal(): React.JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const appVersion = useStore((s) => s.appVersion)
  const [rebuildOpen, setRebuildOpen] = useState(false)

  return (
    <>
      <Modal open={open} onClose={() => setOpen(false)} title="设置" width={460}>
        <div className="space-y-5 text-[13px]">
          <div>
            <p className="mb-2 font-medium">外观</p>
            <div className="flex gap-2">
              {(
                [
                  ['dark', '深色', <Moon key="d" size={14} />],
                  ['light', '浅色', <Sun key="l" size={14} />]
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
            <p className="mb-2 font-medium">缓存维护</p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setRebuildOpen(true)}
                className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink2 hover:bg-hover hover:text-ink"
              >
                <Images size={13} /> 重建全部缩略图
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
            </div>
            <p className="mt-1.5 text-[11px] text-ink3">
              数据（索引库与缩略图）保存在应用数据目录，删除数据目录即完全重置。
            </p>
          </div>

          <div>
            <p className="mb-2 font-medium">关于</p>
            <div className="rounded-lg border border-line bg-panel px-3 py-2.5 text-[12px] leading-relaxed text-ink2">
              <p className="font-semibold text-ink">拾帧 Framora {appVersion || ''}</p>
              <p>Windows 本地写真照片管理 · Electron + React + SQLite + sharp</p>
              <p className="text-[11px] text-ink3">
                所有数据均保存在本机，不上传任何内容到网络。
              </p>
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <PrimaryButton onClick={() => setOpen(false)}>完成</PrimaryButton>
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
    </>
  )
}
