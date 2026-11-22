import React, { useEffect, useRef, useState } from 'react'
import { Star, X, Check, Info, CheckCircle2, AlertTriangle } from 'lucide-react'
import { useStore } from '../store'

export const cn = (
  ...parts: (string | false | null | undefined)[]
): string => parts.filter(Boolean).join(' ')

export function useOutsideClose(ref: React.RefObject<HTMLElement>, onClose: () => void): void {
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handler)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', handler)
      window.removeEventListener('keydown', esc)
    }
  }, [ref, onClose])
}

/* ---------- 按钮 ---------- */

export function IconButton({
  icon,
  label,
  onClick,
  active,
  danger
}: {
  icon: React.ReactNode
  label: string
  onClick?: (e: React.MouseEvent) => void
  active?: boolean
  danger?: boolean
}): React.JSX.Element {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'grid h-8 w-8 place-items-center rounded-md transition-colors',
        active ? 'text-accent bg-accent-soft' : 'text-ink2 hover:text-ink hover:bg-hover',
        danger && 'hover:text-red-400'
      )}
    >
      {icon}
    </button>
  )
}

/* ---------- 星级 ---------- */

export function StarRating({
  value,
  onChange,
  size = 16
}: {
  value: number
  onChange?: (v: number) => void
  size?: number
}): React.JSX.Element {
  const [hover, setHover] = useState(0)
  const shown = hover || value
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          disabled={!onChange}
          onMouseEnter={() => onChange && setHover(i)}
          onMouseLeave={() => onChange && setHover(0)}
          onClick={(e) => {
            e.stopPropagation()
            onChange?.(value === i ? 0 : i)
          }}
          className={cn('p-0', onChange && 'cursor-pointer', !onChange && 'cursor-default')}
          aria-label={`${i} 星`}
        >
          <Star
            style={{ width: size, height: size }}
            className={cn(
              'transition-colors',
              i <= shown ? 'fill-[var(--c-accent)] text-[var(--c-accent)]' : 'text-ink3'
            )}
          />
        </button>
      ))}
    </div>
  )
}

/* ---------- 模态框 ---------- */

/** Modal 栈：嵌套弹窗（设置页内确认框等）时仅栈顶响应 Escape 与焦点循环，
 *  避免一次 Esc 把两层弹窗同时关掉、用户丢失内层状态 */
const modalStack: symbol[] = []
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

export function Modal({
  open,
  onClose,
  title,
  width = 420,
  children,
  footer
}: {
  open: boolean
  onClose: () => void
  title: string
  width?: number
  children: React.ReactNode
  footer?: React.ReactNode
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    const id = Symbol('modal')
    const top = (): boolean => modalStack[modalStack.length - 1] === id
    modalStack.push(id)
    // 记录打开前的焦点，关闭时归还（无障碍基线）
    restoreRef.current = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    const onCloseRef = onClose
    const esc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !top()) return
      e.stopPropagation()
      onCloseRef()
    }
    // 焦点陷阱：Tab / Shift+Tab 在弹窗内循环
    const trap = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !top()) return
      const root = panelRef.current
      if (!root) return
      const list = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (!list.length) {
        e.preventDefault()
        return
      }
      const active = document.activeElement
      const first = list[0]
      const last = list[list.length - 1]
      if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault()
        last.focus()
      }
    }
    window.addEventListener('keydown', esc, true)
    window.addEventListener('keydown', trap, true)
    return () => {
      const i = modalStack.indexOf(id)
      if (i >= 0) modalStack.splice(i, 1)
      window.removeEventListener('keydown', esc, true)
      window.removeEventListener('keydown', trap, true)
      restoreRef.current?.focus?.()
    }
    // onClose 经 ref 间接使用，依赖仅 open：身份变化不重置栈/焦点状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null
  return (
    <div
      className="fixed inset-x-0 bottom-0 top-10 z-50 flex items-center justify-center bg-black/50 animate-fadeIn"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[calc(100vh-80px)] flex-col rounded-win border border-line bg-raised shadow-2xl animate-popIn outline-none"
        style={{ width }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <IconButton icon={<X size={15} />} label="关闭" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  danger
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        danger
          ? 'bg-red-600/90 text-white hover:bg-red-600'
          : 'bg-[var(--c-accent)] text-[#171310] hover:bg-[var(--c-accent-hover)]'
      )}
    >
      {children}
    </button>
  )
}

export function GhostButton({
  children,
  onClick,
  disabled
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-line px-3.5 py-1.5 text-sm text-ink2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
    >
      {children}
    </button>
  )
}

/* ---------- 确认框 ---------- */

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  danger,
  onConfirm,
  onClose
}: {
  open: boolean
  title: string
  message: string
  confirmText?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}): React.JSX.Element | null {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <GhostButton onClick={onClose}>取消</GhostButton>
          <PrimaryButton
            danger={danger}
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirmText}
          </PrimaryButton>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink2">{message}</p>
    </Modal>
  )
}

/* ---------- 输入框对话框 ---------- */

export function InputDialog({
  open,
  title,
  placeholder,
  initial = '',
  confirmText = '确定',
  onConfirm,
  onClose
}: {
  open: boolean
  title: string
  placeholder?: string
  initial?: string
  confirmText?: string
  onConfirm: (value: string) => void
  onClose: () => void
}): React.JSX.Element | null {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) {
      setValue(initial)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open, initial])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <GhostButton onClick={onClose}>取消</GhostButton>
          <PrimaryButton
            onClick={() => {
              const v = value.trim()
              if (v) onConfirm(v)
              onClose()
            }}
          >
            {confirmText}
          </PrimaryButton>
        </>
      }
    >
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) {
            onConfirm(value.trim())
            onClose()
          }
        }}
        className="w-full rounded-md border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-[var(--c-accent)]"
      />
    </Modal>
  )
}

/* ---------- 右键菜单 ---------- */

export interface MenuItem {
  label?: string
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onClick?: () => void
  submenu?: MenuItem[]
}

function MenuList({
  items,
  onClose,
  depth = 0
}: {
  items: MenuItem[]
  onClose: () => void
  depth?: number
}): React.JSX.Element {
  const [openSub, setOpenSub] = useState<number | null>(null)
  return (
    <div
      className={cn(
        'min-w-[168px] rounded-lg border border-line bg-raised py-1.5 shadow-2xl animate-popIn',
        depth > 0 && 'shadow-xl'
      )}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : (
          <div
            key={i}
            className="relative"
            onMouseEnter={() => setOpenSub(item.submenu ? i : null)}
          >
            <button
              disabled={item.disabled}
              onClick={() => {
                if (item.submenu) return
                item.onClick?.()
                onClose()
              }}
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors',
                item.disabled
                  ? 'cursor-not-allowed text-ink3'
                  : item.danger
                    ? 'text-red-400 hover:bg-red-500/10'
                    : 'text-ink2 hover:bg-hover hover:text-ink'
              )}
            >
              {item.icon && <span className="shrink-0 opacity-80">{item.icon}</span>}
              <span className="flex-1 truncate">{item.label}</span>
              {item.submenu && (
                <svg width="12" height="12" viewBox="0 0 24 24" className="text-ink3">
                  <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" />
                </svg>
              )}
            </button>
            {item.submenu && openSub === i && (
              <div className="absolute left-full top-0 z-10 -ml-1">
                <MenuList items={item.submenu} onClose={onClose} depth={depth + 1} />
              </div>
            )}
          </div>
        )
      )}
    </div>
  )
}

export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(ref, onClose)
  const [pos, setPos] = useState({ left: x, top: y })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.min(x, window.innerWidth - r.width - 8)
    const top = Math.min(y, window.innerHeight - r.height - 8)
    setPos({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [x, y])
  return (
    <div ref={ref} className="fixed z-50" style={{ left: pos.left, top: pos.top }}>
      <MenuList items={items} onClose={onClose} />
    </div>
  )
}

/* ---------- 快捷键帮助 ---------- */

export interface ShortcutEntry {
  keys: string
  desc: string
}

/** 全部键盘快捷键的单一事实源：帮助浮层据此渲染，新增快捷键须同步维护 */
export const SHORTCUT_GROUPS: { title: string; items: ShortcutEntry[] }[] = [
  {
    title: '网格浏览',
    items: [
      { keys: 'Ctrl+A', desc: '全选当前视图照片' },
      { keys: '方向键', desc: '移动选中项' },
      { keys: '0 – 5', desc: '为所选照片评分（无选中时评锚点照片），0 清除' },
      { keys: 'Enter / 空格', desc: '打开查看器（单选时）' },
      { keys: 'Delete', desc: '删除所选（确认后移入回收站）' },
      { keys: 'Esc', desc: '清除选择' },
      { keys: '拖拽', desc: '拖入侧边栏相册/标签，或拖出窗口到资源管理器' }
    ]
  },
  {
    title: '查看器',
    items: [
      { keys: '← / →', desc: '上一张 / 下一张' },
      { keys: '1 – 5', desc: '为当前照片评分' },
      { keys: 'Delete', desc: '移入回收站并继续下一张' },
      { keys: 'Home / End', desc: '第一张 / 最后一张' },
      { keys: 'i', desc: '信息面板' },
      { keys: 'r / R', desc: '预览向右 / 向左旋转 90°' },
      { keys: '+ / − / 0', desc: '放大 / 缩小 / 复位缩放' },
      { keys: 'F', desc: '切换全屏' },
      { keys: '拖拽', desc: '拖出窗口到资源管理器，或放回侧边栏相册' },
      { keys: 'Esc / 空格', desc: '关闭查看器' }
    ]
  }
]

/** 快捷键帮助浮层：`?` 键或查看器控制条按钮唤起 */
export function ShortcutHelpModal(): React.JSX.Element {
  const open = useStore((s) => s.helpOpen)
  const setHelpOpen = useStore((s) => s.setHelpOpen)
  return (
    <Modal open={open} onClose={() => setHelpOpen(false)} title="快捷键与拖拽" width={460}>
      <div className="space-y-4">
        {SHORTCUT_GROUPS.map((g) => (
          <div key={g.title}>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink3">
              {g.title}
            </p>
            <div className="space-y-1">
              {g.items.map((it) => (
                <div key={it.keys} className="flex items-center gap-3 text-[12.5px]">
                  <kbd className="min-w-[92px] rounded border border-line bg-panel px-2 py-0.5 text-center font-mono text-[11.5px] text-ink2">
                    {it.keys}
                  </kbd>
                  <span className="text-ink2">{it.desc}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        <p className="text-[11px] text-ink3">随时按 ? 打开此面板，Esc 关闭</p>
      </div>
    </Modal>
  )
}

/* ---------- 吐司 ---------- */

export function Toasts(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[70] flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex max-w-[380px] items-center gap-2.5 rounded-lg border border-line bg-raised px-3.5 py-2.5 shadow-2xl animate-popIn"
        >
          <span
            className={cn(
              'shrink-0',
              t.type === 'error' ? 'text-red-400' : t.type === 'success' ? 'text-emerald-400' : 'text-accent'
            )}
          >
            {t.type === 'error' ? (
              <AlertTriangle size={16} />
            ) : t.type === 'success' ? (
              <CheckCircle2 size={16} />
            ) : (
              <Info size={16} />
            )}
          </span>
          <span className="text-[13px] leading-snug text-ink">{t.text}</span>
          <button
            className="ml-1 shrink-0 text-ink3 hover:text-ink"
            onClick={() => dismiss(t.id)}
            aria-label="关闭提示"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

/* ---------- 标记小件 ---------- */

export function CheckMark({ size = 14 }: { size?: number }): React.JSX.Element {
  return <Check size={size} className="text-[#171310]" strokeWidth={3} />
}
