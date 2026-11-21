import { Loader2, Undo2, X } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { formatCount } from '../lib/format'
import { UNDO_KIND_LABEL } from '@shared/types'

function MiniStopBtn({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid h-4 w-4 place-items-center rounded-full text-ink3 transition-colors hover:bg-hover hover:text-ink"
    >
      <X size={10} />
    </button>
  )
}

export function StatusBar(): React.JSX.Element {
  const total = useStore((s) => s.total)
  const stats = useStore((s) => s.stats)
  const selection = useStore((s) => s.selection)
  const scan = useStore((s) => s.scan)
  const photos = useStore((s) => s.photos)
  const undoEntry = useStore((s) => s.undoEntry)
  const performUndo = useStore((s) => s.performUndo)
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
        {undoEntry && (
          <span className="flex max-w-[320px] items-center gap-1.5">
            <span className="truncate text-ink3">
              已移除{UNDO_KIND_LABEL[undoEntry.kind]}「{undoEntry.label}」
            </span>
            <button
              onClick={() => void performUndo()}
              title={`撤销移除${UNDO_KIND_LABEL[undoEntry.kind]}（恢复照片关系）`}
              className="flex shrink-0 items-center gap-0.5 rounded border border-line px-1.5 py-0.5 text-[10.5px] text-ink2 transition-colors hover:bg-hover hover:text-ink"
            >
              <Undo2 size={10} /> 撤销
            </button>
          </span>
        )}
        {pending > 0 && !scan.active && (
          <span className="flex items-center gap-1">
            生成缩略图 {pending} 张…
            <MiniStopBtn
              label="停止生成缩略图（剩余的将在下次启动时继续）"
              onClick={() => {
                void api
                  .clearThumbQueue()
                  .then((n) =>
                    useStore
                      .getState()
                      .toast('info', `已停止缩略图生成，${n} 张待下次启动时自动继续`),
                  )
                  .catch(() => undefined)
              }}
            />
          </span>
        )}
        {scan.active && (
          <span className="flex items-center gap-1.5 text-accent">
            <Loader2 size={11} className="animate-spin" />
            {scan.label}
            <MiniStopBtn
              label="取消扫描（尚未导入的部分不会写入索引）"
              onClick={() => void api.cancelScan().catch(() => undefined)}
            />
          </span>
        )}
        <span>拾帧 Framora</span>
      </div>
    </div>
  )
}
