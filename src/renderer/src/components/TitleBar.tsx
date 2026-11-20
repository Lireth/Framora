import { Moon, Settings, Sun } from 'lucide-react'
import { useStore } from '../store'
import { cn, IconButton } from './ui'

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

export function TitleBar(): React.JSX.Element {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

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
      <div className={cn('drag-region h-full w-[132px]')} />
    </div>
  )
}
