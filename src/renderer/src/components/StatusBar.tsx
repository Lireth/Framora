import React, { useEffect, useState } from 'react'
import { History, Loader2, Undo2, X } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { formatCount, formatDateTime } from '../lib/format'
import { cn } from './ui'
import { UNDO_KIND_LABEL, type UndoEntry } from '@shared/types'

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
  // 只订阅派生计数：订阅整个 photos 数组会在导入期间随 32ms 合批以约 30 次/秒重渲染
  // 并对万级数组做 O(n) reduce（store 中随照片替换维护）
  const pending = useStore((s) => s.pendingThumbCount)
  const undoEntry = useStore((s) => s.undoEntry)
  const performUndo = useStore((s) => s.performUndo)
  // 撤销历史（FEAT-24）：栈顶在前；撤销按栈顶顺序执行，面板仅做展示
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<UndoEntry[] | null>(null)

  useEffect(() => {
    if (!historyOpen) return
    api
      .listUndo()
      .then(setHistory)
      .catch(() => setHistory([]))
  }, [historyOpen, undoEntry])

  return (
    <div className="relative flex h-7 shrink-0 items-center justify-between border-t border-line bg-panel px-3 text-[11px] text-ink3">
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
          <span className="flex max-w-[360px] items-center gap-1.5">
            <span
              className="truncate text-ink3"
              title={`操作时间：${formatDateTime(undoEntry.at)}`}
            >
              已移除{UNDO_KIND_LABEL[undoEntry.kind]}「{undoEntry.label}」
            </span>
            <button
              onClick={() => void performUndo()}
              title={`撤销移除${UNDO_KIND_LABEL[undoEntry.kind]}（恢复照片关系，操作于 ${formatDateTime(undoEntry.at)}）`}
              className="flex shrink-0 items-center gap-0.5 rounded border border-line px-1.5 py-0.5 text-[10.5px] text-ink2 transition-colors hover:bg-hover hover:text-ink"
            >
              <Undo2 size={10} /> 撤销
            </button>
            <button
              onClick={() => setHistoryOpen((v) => !v)}
              title="撤销历史"
              aria-label="撤销历史"
              className={cn(
                'grid h-5 w-5 shrink-0 place-items-center rounded border border-line text-ink2 transition-colors hover:bg-hover hover:text-ink',
                historyOpen && 'bg-accent-soft text-accent'
              )}
            >
              <History size={11} />
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

      {/* 撤销历史弹层（FEAT-24）：仅展示——撤销语义是 LIFO，只能从栈顶依次恢复 */}
      {historyOpen && undoEntry && (
        <div className="absolute bottom-8 right-3 z-40 w-[320px] rounded-lg border border-line bg-raised py-1 shadow-2xl animate-popIn">
          <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
            <span className="text-[11.5px] font-semibold">撤销历史（栈顶在前）</span>
            <button
              className="text-ink3 hover:text-ink"
              onClick={() => setHistoryOpen(false)}
              aria-label="关闭撤销历史"
            >
              <X size={12} />
            </button>
          </div>
          <div className="max-h-[220px] overflow-y-auto">
            {(history ?? []).map((e, i) => (
              <div
                key={`${e.kind}-${e.id}-${e.at}`}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 text-[11.5px]',
                  i === 0 ? 'text-ink' : 'text-ink3'
                )}
              >
                <span className="w-[30px] shrink-0">{i === 0 ? '栈顶' : `#${i + 1}`}</span>
                <span className="min-w-0 flex-1 truncate">
                  {UNDO_KIND_LABEL[e.kind]}「{e.label}」· {e.photos} 张
                </span>
                <span className="shrink-0 text-[10px]">{formatDateTime(e.at)}</span>
              </div>
            ))}
            {history !== null && history.length === 0 && (
              <p className="px-3 py-2 text-[11.5px]">没有可撤销的操作</p>
            )}
          </div>
          <p className="border-t border-line px-3 py-1.5 text-[10px] leading-relaxed text-ink3">
            撤销按栈顶顺序依次执行：点「撤销」恢复最近一次移除，重复点击逐条恢复。
          </p>
        </div>
      )}
    </div>
  )
}
