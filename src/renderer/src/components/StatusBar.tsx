import { Loader2 } from 'lucide-react'
import { useStore } from '../store'
import { formatCount } from '../lib/format'

export function StatusBar(): React.JSX.Element {
  const total = useStore((s) => s.total)
  const stats = useStore((s) => s.stats)
  const selection = useStore((s) => s.selection)
  const scan = useStore((s) => s.scan)
  const photos = useStore((s) => s.photos)
  const pending = photos.reduce((n, p) => n + (p.thumb_status === 0 && !p.missing ? 1 : 0), 0)

  return (
    <div className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-panel px-3 text-[11px] text-ink3">
      <div className="flex items-center gap-3">
        <span>
          当前视图 <span className="text-ink2">{formatCount(total)}</span> 张
        </span>
        <span>
          资料库 <span className="text-ink2">{formatCount(stats.total)}</span> 张
        </span>
        {selection.size > 0 && <span>已选 {selection.size} 项</span>}
      </div>
      <div className="flex items-center gap-3">
        {pending > 0 && !scan.active && <span>生成缩略图 {pending} 张…</span>}
        {scan.active && (
          <span className="flex items-center gap-1.5 text-accent">
            <Loader2 size={11} className="animate-spin" />
            {scan.label}
          </span>
        )}
        <span>拾帧 Framora</span>
      </div>
    </div>
  )
}
