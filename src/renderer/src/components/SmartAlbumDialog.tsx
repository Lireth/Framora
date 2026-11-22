import React, { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { useStore, type SortKey } from '../store'
import { api } from '../lib/api'
import { chipCls, GhostButton, Modal, PrimaryButton, toggleId } from './ui'
import { SORT_OPTIONS } from '@shared/formats'
import type { SmartAlbumInfo, SmartAlbumQuery } from '@shared/types'

const INPUT_CLS =
  'h-8 w-full rounded-md border border-line bg-panel px-2.5 text-xs outline-none focus:border-[var(--c-accent)]'

/**
 * 智能相册条件编辑器：新建（album=null，draft 为当前筛选）与编辑已有相册共用。
 * 条件语义：多标签 AND、多相册/文件夹 OR，再与关键词/日期/星级取交集。
 */
export function SmartAlbumDialog({
  open,
  album,
  draft,
  onClose,
}: {
  open: boolean
  album: SmartAlbumInfo | null
  draft: SmartAlbumQuery | null
  onClose: () => void
}): React.JSX.Element | null {
  const tags = useStore((s) => s.tags)
  const albums = useStore((s) => s.albums)
  const folders = useStore((s) => s.folders)

  const [name, setName] = useState('')
  const [keyword, setKeyword] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [minRating, setMinRating] = useState(0)
  const [tagIds, setTagIds] = useState<number[]>([])
  const [albumIds, setAlbumIds] = useState<number[]>([])
  const [folderIds, setFolderIds] = useState<number[]>([])
  const [untagged, setUntagged] = useState(false)
  const [sort, setSort] = useState<SortKey>('taken')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    const q = album?.query ?? draft ?? {}
    setName(album?.name ?? '')
    setKeyword(q.keyword ?? '')
    setDateFrom(q.dateFrom ?? '')
    setDateTo(q.dateTo ?? '')
    setMinRating(q.minRating ?? 0)
    setTagIds(q.tagIds ?? [])
    setAlbumIds(q.albumIds ?? [])
    setFolderIds(q.folderIds ?? [])
    setUntagged(q.untagged ?? false)
    setSort(q.sort ?? 'taken')
    setDir(q.dir ?? 'desc')
    setSaving(false)
  }, [open, album, draft])

  if (!open) return null

  const hasFilter =
    !!keyword.trim() ||
    !!dateFrom ||
    !!dateTo ||
    minRating > 0 ||
    tagIds.length > 0 ||
    albumIds.length > 0 ||
    folderIds.length > 0 ||
    untagged

  const save = async (): Promise<void> => {
    const s = useStore.getState()
    const trimmed = name.trim()
    if (!trimmed) {
      s.toast('info', '请填写智能相册名称')
      return
    }
    if (!hasFilter) {
      s.toast('info', '请至少设置一个筛选条件（关键词 / 日期 / 星级 / 标签 / 相册 / 文件夹）')
      return
    }
    const query: SmartAlbumQuery = {
      keyword: keyword.trim() || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      minRating: minRating || undefined,
      tagIds: untagged || !tagIds.length ? undefined : tagIds,
      albumIds: albumIds.length ? albumIds : undefined,
      folderIds: folderIds.length ? folderIds : undefined,
      untagged: untagged || undefined,
      sort,
      dir,
    }
    setSaving(true)
    try {
      if (album) await api.updateSmartAlbum(album.id, trimmed, query)
      else await api.createSmartAlbum(trimmed, query)
      s.toast('success', album ? '智能相册已更新' : '智能相册已保存')
      await s.refreshLibrary()
      if (album && s.scope === 'smart' && s.scopeId === album.id) s.refreshPhotos()
      onClose()
    } catch (e) {
      s.toast('error', e instanceof Error ? e.message : '保存智能相册失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={album ? '编辑智能相册' : '保存为智能相册'}
      width={560}
      footer={
        <>
          <GhostButton onClick={onClose} disabled={saving}>
            取消
          </GhostButton>
          <PrimaryButton onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-4 text-[13px]">
        <div>
          <p className="mb-1.5 text-[12px] text-ink3">名称</p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：2024 旅行精选"
            autoFocus
            className={INPUT_CLS}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <p className="mb-1.5 text-[12px] text-ink3">关键词</p>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="文件名 / 标题 / 描述 / 标签名"
              className={INPUT_CLS}
            />
          </div>
          <div>
            <p className="mb-1.5 text-[12px] text-ink3">起始日期</p>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className={INPUT_CLS}
            />
          </div>
          <div>
            <p className="mb-1.5 text-[12px] text-ink3">结束日期</p>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className={INPUT_CLS}
            />
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-[12px] text-ink3">最低星级</p>
          <div className="flex flex-wrap gap-1.5">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => setMinRating(n)}
                className={chipCls(minRating === n)}
              >
                {n === 0 ? '不限' : `${n}★ 以上`}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[12px] text-ink3">标签（同时包含全部所选）</p>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink3">
              <input
                type="checkbox"
                checked={untagged}
                onChange={(e) => {
                  setUntagged(e.target.checked)
                  if (e.target.checked) setTagIds([])
                }}
                className="accent-[var(--c-accent)]"
              />
              仅未加标签
            </label>
          </div>
          {tags.length ? (
            <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto pr-1">
              {tags.map((t) => (
                <button
                  key={t.id}
                  disabled={untagged}
                  onClick={() => setTagIds((list) => toggleId(list, t.id))}
                  className={chipCls(!untagged && tagIds.includes(t.id))}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full border border-black/20"
                    style={{ background: t.color ?? 'var(--c-ink-3)' }}
                  />
                  {t.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11.5px] text-ink3">暂无标签</p>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-[12px] text-ink3">相册（属于任一所选）</p>
          {albums.length ? (
            <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto pr-1">
              {albums.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setAlbumIds((list) => toggleId(list, a.id))}
                  className={chipCls(albumIds.includes(a.id))}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full border border-black/20"
                    style={{ background: a.color ?? 'var(--c-ink-3)' }}
                  />
                  {a.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11.5px] text-ink3">暂无相册</p>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-[12px] text-ink3">文件夹（限定在任一所选，留空为全库）</p>
          {folders.length ? (
            <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto pr-1">
              {folders.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFolderIds((list) => toggleId(list, f.id))}
                  className={chipCls(folderIds.includes(f.id))}
                >
                  {f.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11.5px] text-ink3">暂无资料库文件夹</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="mb-1.5 text-[12px] text-ink3">排序</p>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className={INPUT_CLS}
            >
              {SORT_OPTIONS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <p className="mb-1.5 text-[12px] text-ink3">方向</p>
            <div className="flex gap-1.5">
              {(['desc', 'asc'] as const).map((d) => (
                <button key={d} onClick={() => setDir(d)} className={chipCls(dir === d)}>
                  {dir === d && <Check size={11} />}
                  {d === 'desc' ? '降序' : '升序'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className="text-[11px] leading-relaxed text-ink3">
          条件取交集：多个标签需同时具备，多个相册 / 文件夹满足其一即可。保存后按条件动态更新，
          照片新增、打标或入册都会自动反映。
        </p>
      </div>
    </Modal>
  )
}
