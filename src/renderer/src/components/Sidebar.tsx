import React from 'react'
import {
  AlertTriangle,
  BookmarkPlus,
  Clock,
  Copy,
  Folder,
  FolderPlus,
  Image,
  Images,
  Palette,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Tag,
  Trash2,
  MapPin,
  BarChart3,
} from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { importFolderAction } from '../lib/actions'
import { cn, ConfirmDialog, InputDialog, type MenuItem } from './ui'
import { useContextMenu } from './useContextMenu'
import { useState } from 'react'
import { formatCount, thumbUrl } from '../lib/format'
import { SORT_LABELS } from '@shared/formats'
import { SmartAlbumDialog } from './SmartAlbumDialog'
import type {
  AlbumInfo,
  FolderInfo,
  PhotoScope,
  SmartAlbumInfo,
  SmartAlbumQuery,
  TagInfo,
} from '@shared/types'

/** 标签/相册颜色预设 */
const COLOR_PRESETS = [
  '#e0533d',
  '#e2983d',
  '#d9c23d',
  '#7fb069',
  '#4f9dd0',
  '#7a6fd0',
  '#d06fb8',
  '#8a8a8a',
]

function colorMenu(onPick: (color: string | null) => void): MenuItem[] {
  return [
    ...COLOR_PRESETS.map((c): MenuItem => ({
      label: c,
      icon: (
        <span
          className="inline-block h-3 w-3 rounded-full border border-line"
          style={{ background: c }}
        />
      ),
      onClick: () => void onPick(c),
    })),
    { separator: true },
    { label: '默认颜色', onClick: () => void onPick(null) },
  ]
}

/** 智能相册条件摘要（悬停提示用）：名称缺失时回退为 id，便于诊断失效引用 */
function smartSummary(
  q: SmartAlbumQuery,
  tags: TagInfo[],
  albums: AlbumInfo[],
  folders: FolderInfo[],
): string {
  const parts: string[] = []
  if (q.keyword) parts.push(`关键词「${q.keyword}」`)
  if (q.dateFrom || q.dateTo) parts.push(`日期 ${q.dateFrom || '…'} 至 ${q.dateTo || '…'}`)
  if (q.minRating) parts.push(`${q.minRating}★ 以上`)
  if (q.tagIds?.length) {
    parts.push(q.tagIds.map((id) => `#${tags.find((t) => t.id === id)?.name ?? id}`).join(' '))
  }
  if (q.albumIds?.length) {
    parts.push(
      `相册：${q.albumIds.map((id) => albums.find((a) => a.id === id)?.name ?? id).join(' / ')}`,
    )
  }
  if (q.folderIds?.length) {
    parts.push(
      `文件夹：${q.folderIds.map((id) => folders.find((f) => f.id === id)?.name ?? id).join(' / ')}`,
    )
  }
  if (q.untagged) parts.push('未加标签')
  if (q.sort) parts.push(`${SORT_LABELS[q.sort] ?? q.sort}${q.dir === 'asc' ? '升序' : '降序'}`)
  return parts.length ? parts.join(' · ') : '未设置条件'
}

function SectionHeader({
  title,
  action,
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
  title,
  count,
  active,
  onClick,
  onContextMenu,
  droppable,
  onDropPhotos,
}: {
  icon: React.ReactNode
  label: string
  /** 悬停提示（智能相册用于展示保存的条件摘要） */
  title?: string
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
      title={title}
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
              // 阻止冒泡到窗口级拖放导入：照片入相册/标签不是文件导入
              e.stopPropagation()
              setDragOver(false)
              // 应用自身发起的原生拖拽（网格瓦片/查看器）携带的 id 集合；
              // at 时间戳 10s 内有效，防止拖拽异常中断后的残留会话误配
              const s = useStore.getState()
              const dragging = s.draggingPhotos
              if (dragging && dragging.ids.length && Date.now() - dragging.at < 10000) {
                s.setDraggingPhotos(null)
                onDropPhotos?.(dragging.ids)
              }
            }
          : undefined
      }
      className={cn(
        'mx-2 flex w-[calc(100%-16px)] items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] transition-colors',
        active ? 'bg-accent-soft text-accent' : 'text-ink2 hover:bg-hover hover:text-ink',
        dragOver && 'ring-1 ring-[var(--c-accent)] bg-accent-soft',
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

  const { open: openMenu, element: menuElement } = useContextMenu()
  const [rename, setRename] = useState<{
    kind: 'album' | 'tag' | 'smart'
    id: number
    name: string
  } | null>(null)
  /** 智能相册编辑器：album=null 表示用 draft（当前筛选）新建 */
  const [smartEdit, setSmartEdit] = useState<{
    album: SmartAlbumInfo | null
    draft: SmartAlbumQuery
  } | null>(null)
  /** 待确认的破坏性元数据删除（文件夹/标签/相册） */
  const [confirmRemove, setConfirmRemove] = useState<{
    kind: 'folder' | 'tag' | 'album'
    id: number
    name: string
    count: number
  } | null>(null)

  /** 执行软删除并刷新；删除后可在状态栏或提示中撤销 */
  const runRemove = async (): Promise<void> => {
    const target = confirmRemove
    if (!target) return
    setConfirmRemove(null)
    const s = useStore.getState()
    try {
      if (target.kind === 'folder') await api.removeFolder(target.id)
      else if (target.kind === 'tag') await api.deleteTag(target.id)
      else await api.deleteAlbum(target.id)
      const scopeAffected =
        (target.kind === 'folder' && s.scope === 'folder' && s.scopeId === target.id) ||
        (target.kind === 'tag' && s.scope === 'tag' && s.scopeId === target.id) ||
        (target.kind === 'album' && s.scope === 'album' && s.scopeId === target.id)
      s.toast(
        'success',
        `已移除${target.kind === 'folder' ? '文件夹' : target.kind === 'tag' ? '标签' : '相册'}「${target.name}」，可在底部状态栏撤销`,
      )
      if (scopeAffected) s.setScope('all')
      await s.refreshLibrary()
      s.refreshPhotos()
      await s.refreshUndo()
    } catch (e) {
      s.toast('error', e instanceof Error ? e.message : '移除失败')
    }
  }

  const folderMenu = (folder: FolderInfo): MenuItem[] => [
    {
      label: '重新扫描',
      icon: <RefreshCw size={13} />,
      onClick: async () => {
        try {
          const r = await api.rescan(folder.id)
          if (r.cancelled) {
            useStore.getState().toast('info', '扫描已取消')
          } else {
            useStore
              .getState()
              .toast(
                'success',
                `扫描完成：新增 ${r.added} 张，更新 ${r.updated} 张${
                  r.unsupported ? `，另有 ${r.unsupported} 个无法解码的照片未导入` : ''
                }`,
              )
            useStore.getState().refreshLibrary()
            useStore.getState().refreshPhotos()
          }
        } catch (e) {
          useStore.getState().toast('error', e instanceof Error ? e.message : '扫描失败')
        }
      },
    },
    { separator: true },
    {
      label: '从资料库移除（可撤销）',
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () =>
        setConfirmRemove({ kind: 'folder', id: folder.id, name: folder.name, count: folder.count }),
    },
  ]

  const albumMenu = (album: AlbumInfo): MenuItem[] => [
    {
      label: '重命名',
      icon: <Pencil size={13} />,
      onClick: () => {
        setRename({ kind: 'album', id: album.id, name: album.name })
      },
    },
    {
      label: '颜色',
      icon: <Palette size={13} />,
      // 失败不再静默（OPT-49）：用户操作无任何反馈曾被列为已知缺陷
      submenu: colorMenu((c) =>
        api
          .setAlbumColor(album.id, c)
          .then(() => useStore.getState().refreshLibrary())
          .catch(() => useStore.getState().toast('error', '设置相册颜色失败')),
      ),
    },
    { separator: true },
    {
      label: '删除相册',
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () =>
        setConfirmRemove({ kind: 'album', id: album.id, name: album.name, count: album.count }),
    },
  ]

  const tagMenu = (tag: TagInfo): MenuItem[] => [
    {
      label: '重命名',
      icon: <Pencil size={13} />,
      onClick: () => {
        setRename({ kind: 'tag', id: tag.id, name: tag.name })
      },
    },
    {
      label: '颜色',
      icon: <Palette size={13} />,
      submenu: colorMenu((c) =>
        api
          .setTagColor(tag.id, c)
          .then(() => useStore.getState().refreshLibrary())
          .catch(() => useStore.getState().toast('error', '设置标签颜色失败')),
      ),
    },
    { separator: true },
    {
      label: '删除标签',
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () =>
        setConfirmRemove({ kind: 'tag', id: tag.id, name: tag.name, count: tag.count }),
    },
  ]

  const smartAlbums = useStore((s) => s.smartAlbums)

  const smartMenu = (sa: SmartAlbumInfo): MenuItem[] => [
    {
      label: '编辑条件…',
      icon: <SlidersHorizontal size={13} />,
      onClick: () => setSmartEdit({ album: sa, draft: sa.query }),
    },
    {
      label: '重命名',
      icon: <Pencil size={13} />,
      onClick: () => {
        setRename({ kind: 'smart', id: sa.id, name: sa.name })
      },
    },
    {
      label: '颜色',
      icon: <Palette size={13} />,
      // 智能相册颜色（FEAT-20）：与标签/相册的色点视觉体系对齐
      submenu: colorMenu((c) =>
        api
          .setSmartAlbumColor(sa.id, c)
          .then(() => useStore.getState().refreshLibrary())
          .catch(() => useStore.getState().toast('error', '设置智能相册颜色失败')),
      ),
    },
    { separator: true },
    {
      label: '删除智能相册',
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: async () => {
        const s = useStore.getState()
        // 失败不再静默吞掉并误报成功（OPT-49）：此前吞异常后无条件提示已删除
        try {
          await api.deleteSmartAlbum(sa.id)
        } catch (err) {
          s.toast('error', err instanceof Error ? err.message : '删除智能相册失败')
          return
        }
        s.toast('success', '智能相册已删除')
        if (s.scope === 'smart' && s.scopeId === sa.id) s.setScope('all')
        s.refreshLibrary()
        s.refreshPhotos()
      },
    },
  ]

  /** 把当前视图的筛选条件（含组合筛选与标签/相册/文件夹作用域）带进智能相册编辑器 */
  const saveCurrentFiltersAsSmart = (): void => {
    const s = useStore.getState()
    const q: SmartAlbumQuery = {
      keyword: s.keyword.trim() || undefined,
      dateFrom: s.dateFrom || undefined,
      dateTo: s.dateTo || undefined,
      minRating: s.minRating || undefined,
      sort: s.sort,
      dir: s.dir,
    }
    // 组合筛选（FEAT-18）与作用域归属合并：同类条件取并集
    const untagged = s.untagged || s.scope === 'untagged'
    if (untagged) q.untagged = true
    if (!untagged) {
      const tagIds = [
        ...new Set([...s.tagIds, ...(s.scope === 'tag' && s.scopeId ? [s.scopeId] : [])]),
      ]
      if (tagIds.length) q.tagIds = tagIds
    }
    const albumIds = [
      ...new Set([...s.albumIds, ...(s.scope === 'album' && s.scopeId ? [s.scopeId] : [])]),
    ]
    if (albumIds.length) q.albumIds = albumIds
    const folderIds = [
      ...new Set([...s.folderIds, ...(s.scope === 'folder' && s.scopeId ? [s.scopeId] : [])]),
    ]
    if (folderIds.length) q.folderIds = folderIds
    const hasFilter =
      !!q.keyword ||
      !!q.dateFrom ||
      !!q.dateTo ||
      !!q.minRating ||
      !!q.tagIds?.length ||
      !!q.albumIds?.length ||
      !!q.folderIds?.length ||
      !!q.untagged
    if (!hasFilter) {
      s.toast('info', '请先设置筛选条件，或进入标签 / 相册 / 文件夹视图再保存')
      return
    }
    setSmartEdit({ album: null, draft: q })
  }

  /** 资料库导航（OPT-52 数据驱动）：8 行同构 NavRow 收敛为配置数组 */
  const libraryNav: {
    key: PhotoScope | 'stats'
    label: string
    icon: React.ReactNode
    count?: number
  }[] = [
    { key: 'all', label: '全部照片', icon: <Image size={15} />, count: stats.total },
    { key: 'recent', label: '最近导入', icon: <Clock size={15} /> },
    { key: 'untagged', label: '未加标签', icon: <Tag size={15} />, count: stats.untagged },
    { key: 'missing', label: '缺失文件', icon: <AlertTriangle size={15} />, count: stats.missing },
    { key: 'stats', label: '资料库统计', icon: <BarChart3 size={15} /> },
    { key: 'map', label: '地点', icon: <MapPin size={15} /> },
    { key: 'duplicates', label: '疑似重复', icon: <Copy size={15} /> },
    { key: 'trash', label: '回收站', icon: <Trash2 size={15} />, count: stats.trash },
  ]

  return (
    <aside className="flex w-[216px] shrink-0 flex-col overflow-y-auto border-r border-line bg-panel pb-3">
      <SectionHeader title="资料库" />
      {libraryNav.map((n) => (
        <NavRow
          key={n.key}
          icon={n.icon}
          label={n.label}
          count={n.count}
          active={n.key !== 'stats' && scope === n.key}
          onClick={() =>
            n.key === 'stats' ? useStore.getState().setStatsOpen(true) : setScope(n.key)
          }
        />
      ))}

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
            openMenu(e.clientX, e.clientY, folderMenu(f))
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
                // 缓存戳必须用封面照片自身的 thumb_ts：用相册成员数充当版本号时，
                // 缩略图重建/封面被编辑后 URL 不变，侧边栏将长期展示陈旧封面
                src={thumbUrl({ id: a.cover_id, thumb_ts: a.cover_thumb_ts ?? 0 })}
                alt=""
                className="h-[22px] w-[22px] rounded object-cover"
                draggable={false}
              />
            ) : a.color ? (
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: a.color }}
              />
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
            openMenu(e.clientX, e.clientY, albumMenu(a))
          }}
        />
      ))}

      <SectionHeader
        title="智能相册"
        action={
          <button
            className="grid h-5 w-5 place-items-center rounded text-ink3 hover:bg-hover hover:text-ink"
            title="保存当前筛选为智能相册"
            onClick={saveCurrentFiltersAsSmart}
          >
            <BookmarkPlus size={13} />
          </button>
        }
      />
      {smartAlbums.length === 0 && (
        <p className="px-4 py-1 text-[11.5px] leading-relaxed text-ink3">
          把当前搜索与筛选条件保存为动态相册
        </p>
      )}
      {smartAlbums.map((sa) => (
        <NavRow
          key={sa.id}
          icon={
            // 色点（FEAT-20）：已设色的智能相册与标签/相册同样以色点呈现
            sa.color ? (
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: sa.color }}
              />
            ) : (
              <SlidersHorizontal size={15} />
            )
          }
          label={sa.name}
          title={smartSummary(sa.query, tags, albums, folders)}
          active={scope === 'smart' && scopeId === sa.id}
          onClick={() => setScope('smart', sa.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            openMenu(e.clientX, e.clientY, smartMenu(sa))
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
            openMenu(e.clientX, e.clientY, tagMenu(t))
          }}
        />
      ))}

      {menuElement}

      <ConfirmDialog
        open={confirmRemove !== null}
        title={
          confirmRemove?.kind === 'folder'
            ? '从资料库移除文件夹'
            : confirmRemove?.kind === 'tag'
              ? '删除标签'
              : '删除相册'
        }
        message={
          confirmRemove?.kind === 'folder'
            ? `将把「${confirmRemove.name}」及其中 ${confirmRemove.count} 张照片从资料库移除。磁盘文件不会被删除，评分、标签与相册归属会保留，可在底部状态栏撤销。`
            : confirmRemove?.kind === 'tag'
              ? `将删除标签「${confirmRemove.name}」（${confirmRemove.count} 张照片使用）。照片文件不受影响，标签关系会保留，可在底部状态栏撤销。`
              : `将删除相册「${confirmRemove?.name ?? ''}」（${confirmRemove?.count ?? 0} 张照片）。照片文件不受影响，相册归属会保留，可在底部状态栏撤销。`
        }
        confirmText={
          confirmRemove?.kind === 'folder'
            ? '移除资料库'
            : confirmRemove?.kind === 'tag'
              ? '删除标签'
              : '删除相册'
        }
        danger
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => void runRemove()}
      />

      <InputDialog
        open={!!rename}
        title={
          rename?.kind === 'album'
            ? rename.id === -1
              ? '新建相册'
              : '重命名相册'
            : rename?.kind === 'smart'
              ? rename.id === -1
                ? '保存当前筛选为智能相册'
                : '重命名智能相册'
              : rename?.kind === 'tag'
                ? rename.id === -1
                  ? '新建标签'
                  : '重命名标签'
                : ''
        }
        initial={rename?.name ?? ''}
        placeholder={
          rename?.kind === 'album'
            ? '例如：胶片风人像'
            : rename?.kind === 'smart'
              ? '例如：上个月的五星精选'
              : '例如：室外'
        }
        onClose={() => setRename(null)}
        onConfirm={async (raw) => {
          if (!rename) return
          try {
            if (rename.kind === 'album') {
              if (rename.id === -1) await api.createAlbum(raw, null)
              else await api.renameAlbum(rename.id, raw)
            } else if (rename.kind === 'smart') {
              // 新建走 SmartAlbumDialog；此处仅处理重命名
              if (rename.id !== -1) await api.renameSmartAlbum(rename.id, raw)
            } else {
              if (rename.id === -1) await api.createTag(raw, null)
              else await api.renameTag(rename.id, raw)
            }
            useStore.getState().refreshLibrary()
          } catch (e) {
            useStore.getState().toast('error', e instanceof Error ? e.message : '操作失败')
          }
        }}
      />

      <SmartAlbumDialog
        open={!!smartEdit}
        album={smartEdit?.album ?? null}
        draft={smartEdit?.draft ?? null}
        onClose={() => setSmartEdit(null)}
      />
    </aside>
  )
}

