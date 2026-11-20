import React from 'react'
import {
  AlertTriangle,
  Clock,
  Folder,
  FolderPlus,
  Image,
  Images,
  Palette,
  Pencil,
  RefreshCw,
  Tag,
  Trash2
} from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { importFolderAction } from '../lib/actions'
import { cn, ContextMenu, type MenuItem } from './ui'
import { useState } from 'react'
import { formatCount, thumbUrl } from '../lib/format'

/** 标签/相册颜色预设 */
const COLOR_PRESETS = [
  '#e0533d',
  '#e2983d',
  '#d9c23d',
  '#7fb069',
  '#4f9dd0',
  '#7a6fd0',
  '#d06fb8',
  '#8a8a8a'
]

function colorMenu(onPick: (color: string | null) => void): MenuItem[] {
  return [
    ...COLOR_PRESETS.map(
      (c): MenuItem => ({
        label: c,
        icon: <span className="inline-block h-3 w-3 rounded-full border border-line" style={{ background: c }} />,
        onClick: () => void onPick(c)
      })
    ),
    { separator: true },
    { label: '默认颜色', onClick: () => void onPick(null) }
  ]
}

function SectionHeader({
  title,
  action
}: {
  title: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 pb-1.5 pt-4">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink3">
        {title}
      </span>
      {action}
    </div>
  )
}

function NavRow({
  icon,
  label,
  count,
  active,
  onClick,
  onContextMenu,
  droppable,
  onDropPhotos
}: {
  icon: React.ReactNode
  label: string
  count?: number
  active: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  /** 允许把照片拖入此行（相册/标签） */
  droppable?: boolean
  onDropPhotos?: (ids: number[]) => void
}): React.JSX.Element {
  const [dragOver, setDragOver] = useState(false)
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragOver={
        droppable
          ? (e) => {
              e.preventDefault()
              e.stopPropagation()
              if (!dragOver) setDragOver(true)
            }
          : undefined
      }
      onDragLeave={droppable ? () => setDragOver(false) : undefined}
      onDrop={
        droppable
          ? (e) => {
              e.preventDefault()
              setDragOver(false)
              try {
                const raw = e.dataTransfer.getData('application/x-framora-photos')
                const ids = JSON.parse(raw) as unknown
                if (Array.isArray(ids) && ids.length && ids.every((x) => typeof x === 'number')) {
                  onDropPhotos?.(ids)
                }
              } catch {
                /* 无效拖拽数据忽略 */
              }
            }
          : undefined
      }
      className={cn(
        'mx-2 flex w-[calc(100%-16px)] items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] transition-colors',
        active ? 'bg-accent-soft text-accent' : 'text-ink2 hover:bg-hover hover:text-ink',
        dragOver && 'ring-1 ring-[var(--c-accent)] bg-accent-soft'
      )}
    >
      <span className={cn('shrink-0', active ? 'text-accent' : 'text-ink3')}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && <span className="text-[11px] text-ink3">{formatCount(count)}</span>}
    </button>
  )
}

export function Sidebar(): React.JSX.Element {
  const scope = useStore((s) => s.scope)
  const scopeId = useStore((s) => s.scopeId)
  const folders = useStore((s) => s.folders)
  const albums = useStore((s) => s.albums)
  const tags = useStore((s) => s.tags)
  const stats = useStore((s) => s.stats)
  const setScope = useStore((s) => s.setScope)

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [rename, setRename] = useState<{ kind: 'album' | 'tag'; id: number; name: string } | null>(
    null
  )
  const [renameValue, setRenameValue] = useState('')

  const folderMenu = (id: number): MenuItem[] => [
    {
      label: '重新扫描',
      icon: <RefreshCw size={13} />,
      onClick: async () => {
        try {
          const r = await api.rescan(id)
          useStore.getState().toast('success', `扫描完成：新增 ${r.added} 张，更新 ${r.updated} 张`)
          useStore.getState().refreshLibrary()
          useStore.getState().refreshPhotos()
        } catch (e) {
          useStore.getState().toast('error', e instanceof Error ? e.message : '扫描失败')
        }
      }
    },
    { separator: true },
    {
      label: '移除索引（保留磁盘文件）',
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: async () => {
        try {
          await api.removeFolder(id)
          useStore.getState().toast('success', '文件夹已从资料库移除')
          if (useStore.getState().scope === 'folder' && useStore.getState().scopeId === id) {
            useStore.getState().setScope('all')
          }
          useStore.getState().refreshLibrary()
          useStore.getState().refreshPhotos()
        } catch (e) {
          useStore.getState().toast('error', e instanceof Error ? e.message : '移除失败')
        }
      }
    }
  ]

  const albumMenu = (id: number, name: string): MenuItem[] => [
    {
      label: '重命名',
      icon: <Pencil size={13} />,
      onClick: () => {
        setRename({ kind: 'album', id, name })
        setRenameValue(name)
      }
    },
    {
      label: '颜色',
      icon: <Palette size={13} />,
      submenu: colorMenu((c) =>
        api
          .setAlbumColor(id, c)
          .then(() => useStore.getState().refreshLibrary())
          .catch(() => undefined)
      )
    },
    { separator: true },
    {
      label: '删除相册',
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: async () => {
        await api.deleteAlbum(id).catch(() => undefined)
        useStore.getState().toast('success', '相册已删除')
        if (useStore.getState().scope === 'album' && useStore.getState().scopeId === id) {
          useStore.getState().setScope('all')
        }
        useStore.getState().refreshLibrary()
        useStore.getState().refreshPhotos()
      }
    }
  ]

  const tagMenu = (id: number, name: string): MenuItem[] => [
    {
      label: '重命名',
      icon: <Pencil size={13} />,
      onClick: () => {
        setRename({ kind: 'tag', id, name })
        setRenameValue(name)
      }
    },
    {
      label: '颜色',
      icon: <Palette size={13} />,
      submenu: colorMenu((c) =>
        api
          .setTagColor(id, c)
          .then(() => useStore.getState().refreshLibrary())
          .catch(() => undefined)
      )
    },
    { separator: true },
    {
      label: '删除标签',
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: async () => {
        await api.deleteTag(id).catch(() => undefined)
        useStore.getState().toast('success', '标签已删除')
        if (useStore.getState().scope === 'tag' && useStore.getState().scopeId === id) {
          useStore.getState().setScope('all')
        }
        useStore.getState().refreshLibrary()
        useStore.getState().refreshPhotos()
      }
    }
  ]

  return (
    <aside className="flex w-[216px] shrink-0 flex-col overflow-y-auto border-r border-line bg-panel pb-3">
      <SectionHeader title="资料库" />
      <NavRow
        icon={<Image size={15} />}
        label="全部照片"
        count={stats.total}
        active={scope === 'all'}
        onClick={() => setScope('all')}
      />
      <NavRow
        icon={<Clock size={15} />}
        label="最近导入"
        active={scope === 'recent'}
        onClick={() => setScope('recent')}
      />
      <NavRow
        icon={<Tag size={15} />}
        label="未加标签"
        count={stats.untagged}
        active={scope === 'untagged'}
        onClick={() => setScope('untagged')}
      />
      <NavRow
        icon={<AlertTriangle size={15} />}
        label="缺失文件"
        count={stats.missing}
        active={scope === 'missing'}
        onClick={() => setScope('missing')}
      />

      <SectionHeader
        title="文件夹"
        action={
          <button
            className="grid h-5 w-5 place-items-center rounded text-ink3 hover:bg-hover hover:text-ink"
            title="导入文件夹"
            onClick={() => importFolderAction()}
          >
            <FolderPlus size={13} />
          </button>
        }
      />
      {folders.length === 0 && (
        <p className="px-4 py-1 text-[11.5px] leading-relaxed text-ink3">还没有导入文件夹</p>
      )}
      {folders.map((f) => (
        <NavRow
          key={f.id}
          icon={<Folder size={15} />}
          label={f.name}
          count={f.count}
          active={scope === 'folder' && scopeId === f.id}
          onClick={() => setScope('folder', f.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, items: folderMenu(f.id) })
          }}
        />
      ))}

      <SectionHeader
        title="相册"
        action={
          <button
            className="grid h-5 w-5 place-items-center rounded text-ink3 hover:bg-hover hover:text-ink"
            title="新建相册"
            onClick={() => {
              setRename({ kind: 'album', id: -1, name: '' })
              setRenameValue('')
            }}
          >
            <Images size={13} />
          </button>
        }
      />
      {albums.map((a) => (
        <NavRow
          key={a.id}
          icon={
            a.cover_id ? (
              <img
                src={thumbUrl({ id: a.cover_id, thumb_ts: a.count })}
                alt=""
                className="h-[22px] w-[22px] rounded object-cover"
                draggable={false}
              />
            ) : a.color ? (
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: a.color }} />
            ) : (
              <Images size={15} />
            )
          }
          label={a.name}
          count={a.count}
          active={scope === 'album' && scopeId === a.id}
          onClick={() => setScope('album', a.id)}
          droppable
          onDropPhotos={(ids) =>
            api
              .batchAlbum(ids, a.id)
              .then(() => {
                useStore.getState().toast('success', `已将 ${ids.length} 张照片加入「${a.name}」`)
                useStore.getState().refreshLibrary()
                useStore.getState().refreshPhotos()
              })
              .catch(() => useStore.getState().toast('error', '加入相册失败'))
          }
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, items: albumMenu(a.id, a.name) })
          }}
        />
      ))}

      <SectionHeader
        title="标签"
        action={
          <button
            className="grid h-5 w-5 place-items-center rounded text-ink3 hover:bg-hover hover:text-ink"
            title="新建标签"
            onClick={() => {
              setRename({ kind: 'tag', id: -1, name: '' })
              setRenameValue('')
            }}
          >
            <Tag size={13} />
          </button>
        }
      />
      {tags.map((t) => (
        <NavRow
          key={t.id}
          icon={
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: t.color ?? 'var(--c-accent)' }}
            />
          }
          label={t.name}
          count={t.count}
          active={scope === 'tag' && scopeId === t.id}
          onClick={() => setScope('tag', t.id)}
          droppable
          onDropPhotos={(ids) =>
            api
              .batchTags(ids, [t.id], [])
              .then(() => {
                useStore.getState().toast('success', `已为 ${ids.length} 张照片添加「${t.name}」`)
                useStore.getState().refreshLibrary()
                useStore.getState().refreshPhotos()
              })
              .catch(() => useStore.getState().toast('error', '添加标签失败'))
          }
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, items: tagMenu(t.id, t.name) })
          }}
        />
      ))}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {rename && (
        <RenameDialog
          kind={rename.kind}
          isNew={rename.id === -1}
          value={renameValue}
          setValue={setRenameValue}
          close={() => setRename(null)}
          confirm={async () => {
            const name = renameValue.trim()
            if (!name) return
            try {
              if (rename.kind === 'album') {
                if (rename.id === -1) await api.createAlbum(name, null)
                else await api.renameAlbum(rename.id, name)
              } else {
                if (rename.id === -1) await api.createTag(name, null)
                else await api.renameTag(rename.id, name)
              }
              useStore.getState().refreshLibrary()
            } catch (e) {
              useStore.getState().toast('error', e instanceof Error ? e.message : '操作失败')
            }
          }}
        />
      )}
    </aside>
  )
}

function RenameDialog({
  kind,
  isNew,
  value,
  setValue,
  close,
  confirm
}: {
  kind: 'album' | 'tag'
  isNew: boolean
  value: string
  setValue: (v: string) => void
  close: () => void
  confirm: () => Promise<void>
}): React.JSX.Element {
  const inputRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [])
  const title = kind === 'album' ? (isNew ? '新建相册' : '重命名相册') : isNew ? '新建标签' : '重命名标签'
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fadeIn"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="w-[360px] rounded-win border border-line bg-raised p-4 shadow-2xl animate-popIn">
        <h3 className="mb-3 text-sm font-semibold">{title}</h3>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === 'Enter') {
              await confirm()
              close()
            }
            if (e.key === 'Escape') close()
          }}
          placeholder={kind === 'album' ? '例如：胶片风人像' : '例如：室外'}
          className="w-full rounded-md border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-[var(--c-accent)]"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink2 hover:bg-hover"
            onClick={close}
          >
            取消
          </button>
          <button
            className="rounded-md bg-[var(--c-accent)] px-3.5 py-1.5 text-sm font-medium text-[#171310] hover:bg-[var(--c-accent-hover)]"
            onClick={async () => {
              await confirm()
              close()
            }}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
