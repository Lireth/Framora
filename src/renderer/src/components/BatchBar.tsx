import React, { useState } from 'react'
import { ArchiveRestore, Download, Images, Pencil, Repeat, Star, Tag, Trash2, X } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { deletePhotosAction, purgePhotosAction, restorePhotosAction } from '../lib/actions'
import { ConfirmDialog, InputDialog, type MenuItem } from './ui'
import { useContextMenu } from './useContextMenu'
import { TagPicker } from './TagPicker'

export function BatchBar(): React.JSX.Element {
  const selection = useStore((s) => s.selection)
  const scope = useStore((s) => s.scope)
  const inTrash = scope === 'trash'
  const clearSelection = useStore((s) => s.clearSelection)
  const openExport = useStore((s) => s.openExport)
  const openConvert = useStore((s) => s.openConvert)
  const confirmDeleteOpen = useStore((s) => s.confirmDeleteOpen)
  const setConfirmDeleteOpen = useStore((s) => s.setConfirmDeleteOpen)
  const albums = useStore((s) => s.albums)

  const [tagPicker, setTagPicker] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const { open: openMenu, element: menuElement } = useContextMenu()
  const ids = [...selection]

  if (selection.size === 0 && !confirmDeleteOpen) return <ConfirmHost />

  const openAlbumMenu = (e: React.MouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const items: MenuItem[] = [
      ...albums.map((a) => ({
        label: `加入「${a.name}」`,
        icon: <Images size={13} />,
        onClick: async () => {
          await api.batchAlbum(ids, a.id)
          useStore.getState().toast('success', `已加入相册「${a.name}」`)
          useStore.getState().refreshLibrary()
        }
      })),
      ...(albums.length ? [{ separator: true } as MenuItem] : []),
      {
        label: '从所有相册移出',
        onClick: async () => {
          await api.batchAlbum(ids, null)
          useStore.getState().toast('success', '已从所有相册移出')
          useStore.getState().refreshLibrary()
        }
      }
    ]
    openMenu(rect.left, rect.top - 8, items)
  }

  const openRateMenu = (e: React.MouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const items: MenuItem[] = [0, 1, 2, 3, 4, 5].map((v) => ({
      label: v === 0 ? '清除星级' : `${'★'.repeat(v)}`,
      onClick: async () => {
        await api.batchRate(ids, v)
        useStore.getState().toast('success', `已设置 ${v === 0 ? '清除' : v + ' 星'}（${ids.length} 张）`)
        useStore.getState().refreshPhotos()
      }
    }))
    openMenu(rect.left, rect.top - 8, items)
  }

  return (
    <>
      <ConfirmHost />
      {selection.size > 0 && (
        <div className="fixed bottom-12 left-1/2 z-40 -translate-x-1/2 animate-popIn">
          <div className="flex items-center gap-1 rounded-full border border-line bg-raised/95 px-2.5 py-1.5 shadow-2xl backdrop-blur">
            <span className="px-2 text-[12.5px] text-ink2">
              已选 <b className="text-ink">{selection.size}</b> 项
            </span>
            <span className="mx-1 h-5 w-px bg-line" />
            {inTrash ? (
              <>
                <BarBtn
                  icon={<ArchiveRestore size={14} />}
                  label="还原到原位置"
                  onClick={() => void restorePhotosAction(ids)}
                />
                <BarBtn
                  icon={<Trash2 size={14} />}
                  label="彻底删除"
                  danger
                  onClick={() => setConfirmDeleteOpen(true)}
                />
              </>
            ) : (
              <>
                <BarBtn icon={<Star size={14} />} label="设置星级" onClick={openRateMenu} />
                <BarBtn icon={<Tag size={14} />} label="添加标签" onClick={() => setTagPicker(!tagPicker)} />
                <BarBtn icon={<Images size={14} />} label="加入相册" onClick={openAlbumMenu} />
                <BarBtn icon={<Pencil size={14} />} label="批量重命名" onClick={() => setRenameOpen(true)} />
                <BarBtn icon={<Download size={14} />} label="批量导出" onClick={() => openExport(ids)} />
                <BarBtn
                  icon={<Repeat size={14} />}
                  label="转换格式（输出到源文件夹，源移入回收站）"
                  onClick={() => openConvert(ids)}
                />
                <BarBtn
                  icon={<Trash2 size={14} />}
                  label="批量删除"
                  danger
                  onClick={() => setConfirmDeleteOpen(true)}
                />
              </>
            )}
            <span className="mx-1 h-5 w-px bg-line" />
            <BarBtn icon={<X size={14} />} label="取消选择" onClick={clearSelection} />
          </div>
        </div>
      )}
      {tagPicker && selection.size > 0 && (
        <div className="fixed inset-0 z-[55]" onMouseDown={() => setTagPicker(false)}>
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <TagPicker photoIds={ids} title={`批量管理 ${ids.length} 张照片的标签`} onClose={() => setTagPicker(false)} />
          </div>
        </div>
      )}
      {menuElement}
      <InputDialog
        open={renameOpen}
        title={`批量重命名 ${ids.length} 张照片`}
        placeholder="例如：{date}-{index} 或 写真-{index}"
        confirmText="开始重命名"
        onClose={() => setRenameOpen(false)}
        onConfirm={(tpl) => {
          void api
            .batchRename(ids, tpl)
            .then((r) => {
              const s = useStore.getState()
              s.toast(
                r.failed ? 'info' : 'success',
                `重命名 ${r.renamed} 张，跳过 ${r.skipped} 张${r.failed ? `，失败 ${r.failed} 张` : ''}`
              )
              s.refreshPhotos()
            })
            .catch(() => useStore.getState().toast('error', '批量重命名失败'))
        }}
      />
    </>
  )
}

function BarBtn({
  icon,
  label,
  onClick,
  danger
}: {
  icon: React.ReactNode
  label: string
  onClick: (e: React.MouseEvent) => void
  danger?: boolean
}): React.JSX.Element {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={
        'grid h-8 w-8 place-items-center rounded-full text-ink2 transition-colors hover:bg-hover hover:text-ink' +
        (danger ? ' hover:text-red-400' : '')
      }
    >
      {icon}
    </button>
  )
}

/** 全局删除确认（网格 Delete 键 / 批量栏 / 右键菜单共用）；回收站作用域下为彻底删除 */
function ConfirmHost(): React.JSX.Element {
  const open = useStore((s) => s.confirmDeleteOpen)
  const setOpen = useStore((s) => s.setConfirmDeleteOpen)
  const selection = useStore((s) => s.selection)
  const scope = useStore((s) => s.scope)
  const inTrash = scope === 'trash'
  return (
    <ConfirmDialog
      open={open}
      title={inTrash ? '彻底删除照片' : '删除照片'}
      message={
        inTrash
          ? `将把选中的 ${selection.size} 张照片移入系统回收站并从索引中移除（无法在应用内还原）。确定继续吗？`
          : `将把选中的 ${selection.size} 张照片移入应用内回收站（文件保留在原位置，可随时还原或彻底删除）。确定继续吗？`
      }
      confirmText={inTrash ? '彻底删除' : '移入回收站'}
      danger
      onClose={() => setOpen(false)}
      onConfirm={() =>
        inTrash ? purgePhotosAction([...selection]) : deletePhotosAction([...selection])
      }
    />
  )
}
