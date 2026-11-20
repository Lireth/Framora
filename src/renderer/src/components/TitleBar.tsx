import { useEffect, useState } from 'react'
import { Copy, Minus, Moon, Settings, Square, Sun, X } from 'lucide-react'
import { useStore } from '../store'
import { api, onEvent } from '../lib/api'
import { IconButton } from './ui'

function Logo(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 512 512" className="shrink-0">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e2a63d" />
          <stop offset="1" stopColor="#c2410c" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill="url(#lg)" />
      <rect x="128" y="128" width="256" height="256" rx="30" fill="none" stroke="#171310" strokeOpacity="0.85" strokeWidth="34" />
      <circle cx="256" cy="256" r="52" fill="#171310" fillOpacity="0.85" />
    </svg>
  )
}

function WinButton({
  label,
  onClick,
  danger,
  children
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={
        danger
          ? 'grid h-full w-[46px] place-items-center text-ink2 transition-colors hover:bg-[#c42b1c] hover:text-white'
          : 'grid h-full w-[46px] place-items-center text-ink2 transition-colors hover:bg-hover hover:text-ink'
      }
    >
      {children}
    </button>
  )
}

export function TitleBar(): React.JSX.Element {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    api
      .isMaximized()
      .then(setMaximized)
      .catch(() => undefined)
    return onEvent('evt:maximize', (data) => setMaximized(data as boolean))
  }, [])

  return (
    <div className="drag-region flex h-10 shrink-0 select-none items-center border-b border-line bg-panel pl-3.5">
      <div className="flex items-center gap-2.5">
        <Logo />
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold tracking-wide">拾帧</span>
          <span className="text-[10px] font-medium uppercase tracking-[0.22em] text-ink3">
            Framora
          </span>
        </div>
      </div>
      <div className="flex-1" />
      <div className="no-drag flex items-center gap-0.5">
        <IconButton
          icon={theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          label={theme === 'dark' ? '切换浅色主题' : '切换深色主题'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />
        <IconButton
          icon={<Settings size={15} />}
          label="设置"
          onClick={() => setSettingsOpen(true)}
        />
      </div>
      <div className="no-drag ml-1 flex h-full items-stretch">
        <WinButton label="最小化" onClick={() => void api.minimizeWindow()}>
          <Minus size={13} strokeWidth={1.4} />
        </WinButton>
        <WinButton label={maximized ? '向下还原' : '最大化'} onClick={() => void api.toggleMaximize()}>
          {maximized ? <Copy size={11} strokeWidth={1.4} /> : <Square size={11} strokeWidth={1.4} />}
        </WinButton>
        <WinButton label="关闭" danger onClick={() => void api.closeWindow()}>
          <X size={13} strokeWidth={1.4} />
        </WinButton>
      </div>
    </div>
  )
}
