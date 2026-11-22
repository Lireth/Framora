import { useCallback, useState } from 'react'
import { ContextMenu, type MenuItem } from './ui'

export interface ContextMenuState {
  x: number
  y: number
  items: MenuItem[]
}

/**
 * 右键菜单状态复用（OPT-35 去重）：Sidebar/网格瓦片/批量栏三处原本各自维护
 * `useState<{x,y,items}|null>` + set + `<ContextMen onClose>` 的同款模式。
 */
export function useContextMenu(): {
  menu: ContextMenuState | null
  open: (x: number, y: number, items: MenuItem[]) => void
  close: () => void
  /** 挂到调用方 JSX 的现成菜单节点（无菜单时为 null） */
  element: React.JSX.Element | null
} {
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const open = useCallback((x: number, y: number, items: MenuItem[]) => {
    setMenu({ x, y, items })
  }, [])
  const close = useCallback(() => setMenu(null), [])
  const element = menu ? (
    <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} />
  ) : null
  return { menu, open, close, element }
}
