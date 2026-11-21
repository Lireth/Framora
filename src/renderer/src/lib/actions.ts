import { api } from './api'
import { useStore } from '../store'

/** 选择并导入文件夹 */
export async function importFolderAction(): Promise<void> {
  const s = useStore.getState()
  try {
    const dir = await api.pickFolder()
    if (!dir) return
    s.setScan({ active: true, label: '正在扫描文件夹…' })
    const r = await api.importFolder(dir)
    s.setScan({ active: false, label: '' })
    if (r.cancelled) {
      s.toast('info', '导入已取消')
    } else {
      s.toast(
        'success',
        `导入完成：发现 ${r.found} 张，新增 ${r.added} 张，更新 ${r.updated} 张${
          r.unsupported ? `，另有 ${r.unsupported} 个无法解码的照片未导入` : ''
        }`
      )
    }
    await s.refreshLibrary()
    s.refreshPhotos()
  } catch (e) {
    useStore.getState().setScan({ active: false, label: '' })
    useStore.getState().toast('error', e instanceof Error ? e.message : '导入失败')
  }
}

/** 选择单张/多张照片导入（库内直接入库，库外复制入目标文件夹） */
export async function importFilesAction(): Promise<void> {
  const s = useStore.getState()
  try {
    const paths = await api.pickFiles()
    if (!paths || !paths.length) return
    const r = await api.importFiles(paths)
    const parts: string[] = []
    if (r.indexed) parts.push(`入库 ${r.indexed} 张`)
    if (r.copied) parts.push(`复制导入 ${r.copied} 张`)
    if (r.skipped) parts.push(`跳过 ${r.skipped} 张`)
    if (parts.length) {
      s.toast('success', `导入文件：${parts.join('，')}`)
    } else {
      s.toast('info', '导入文件：没有新增照片')
    }
    await s.refreshLibrary()
    s.refreshPhotos()
  } catch (e) {
    useStore.getState().toast('error', e instanceof Error ? e.message : '导入文件失败')
  }
}

/** 重复治理：按策略保留每组一张，选中其余冗余项（随后可批量删除） */
export async function selectRedundantAction(mode: 'best' | 'oldest'): Promise<void> {
  const s = useStore.getState()
  try {
    const r = await api.selectRedundant(mode)
    if (!r.ids.length) {
      s.toast('info', r.clusters ? '各组已只剩一张，无冗余可清理' : '没有发现重复照片')
      return
    }
    s.setSelection(r.ids)
    s.toast('success', `已选中 ${r.ids.length} 张冗余照片（${r.clusters} 组），可批量删除`)
  } catch (e) {
    useStore.getState().toast('error', e instanceof Error ? e.message : '选择冗余项失败')
  }
}

/** 删除（移入应用内回收站，文件保留在原位置，可还原）所选照片 */
export async function deletePhotosAction(ids: number[]): Promise<void> {
  if (!ids.length) return
  const s = useStore.getState()
  try {
    const r = await api.deletePhotos(ids)
    if (r.failed > 0) {
      s.toast('error', `已删除 ${r.deleted} 张，${r.failed} 张删除失败`)
    } else {
      s.toast('success', `已将 ${r.deleted} 张照片移入回收站（可在回收站视图还原）`)
    }
    s.clearSelection()
    if (s.viewerOpen) s.closeViewer()
    await s.refreshLibrary()
    s.refreshPhotos()
  } catch (e) {
    s.toast('error', e instanceof Error ? e.message : '删除失败')
  }
}

/**
 * 查看器内删除当前照片并留在查看器继续筛选：优先前进到下一张，末张则回退上一张。
 * 与网格删除（需确认）不同：审片流要求连续操作，且软删除本身可从回收站还原。
 */
export async function deleteViewerPhotoAction(): Promise<void> {
  const s = useStore.getState()
  if (!s.viewerOpen || s.activeId === null || s.scope === 'trash') return
  const idx = s.photos.findIndex((p) => p.id === s.activeId)
  if (idx < 0) return
  const id = s.photos[idx].id
  const nextId =
    idx + 1 < s.photos.length ? s.photos[idx + 1].id : idx - 1 >= 0 ? s.photos[idx - 1].id : null
  try {
    const r = await api.deletePhotos([id])
    if (r.failed > 0) {
      s.toast('error', '删除失败（文件可能被其他程序占用）')
      return
    }
    s.toast('success', '已移入回收站（可在回收站视图还原）')
    // 从选择集中移除已删除项（查看器可能从多选进入，保留其余选择）
    s.setSelection([...s.selection].filter((x) => x !== id))
    if (nextId === null) s.closeViewer()
    else s.setActive(nextId)
    await s.refreshLibrary()
    await s.refreshPhotos()
    // 刷新后目标照片不在当前视图（查询条件被并发修改）时回退定位，避免空查看器
    const st = useStore.getState()
    if (st.viewerOpen && !st.photos.some((p) => p.id === st.activeId)) {
      if (st.photos.length) st.setActive(st.photos[0].id)
      else st.closeViewer()
    }
  } catch (e) {
    s.toast('error', e instanceof Error ? e.message : '删除失败')
  }
}

/** 查看器内快捷键评分（1-5）：与详情面板星级相同的乐观更新路径 */
export async function rateViewerPhotoAction(rating: number): Promise<void> {
  const s = useStore.getState()
  if (!s.viewerOpen || s.activeId === null) return
  const id = s.activeId
  try {
    await api.updateMeta(id, { rating })
    s.patchPhoto(id, { rating })
  } catch (e) {
    s.toast('error', e instanceof Error ? e.message : '评分失败')
  }
}

/** 从回收站还原所选照片 */
export async function restorePhotosAction(ids: number[]): Promise<void> {
  if (!ids.length) return
  const s = useStore.getState()
  try {
    const r = await api.restorePhotos(ids)
    s.toast('success', `已还原 ${r.restored} 张照片`)
    s.clearSelection()
    await s.refreshLibrary()
    s.refreshPhotos()
  } catch (e) {
    s.toast('error', e instanceof Error ? e.message : '还原失败')
  }
}

/** 彻底删除（移入系统回收站并从索引移除，不可在应用内还原） */
export async function purgePhotosAction(ids: number[]): Promise<void> {
  if (!ids.length) return
  const s = useStore.getState()
  try {
    const r = await api.purgePhotos(ids)
    if (r.failed > 0) {
      s.toast('error', `已彻底删除 ${r.deleted} 张，${r.failed} 张失败`)
    } else {
      s.toast('success', `已彻底删除 ${r.deleted} 张照片`)
    }
    s.clearSelection()
    if (s.viewerOpen) s.closeViewer()
    await s.refreshLibrary()
    s.refreshPhotos()
  } catch (e) {
    s.toast('error', e instanceof Error ? e.message : '彻底删除失败')
  }
}

/** 清空回收站 */
export async function emptyTrashAction(): Promise<void> {
  const s = useStore.getState()
  try {
    const r = await api.emptyTrash()
    if (r.failed > 0) {
      s.toast('error', `已清空 ${r.deleted} 张，${r.failed} 张失败`)
    } else {
      s.toast('success', `已清空回收站（${r.deleted} 张）`)
    }
    s.clearSelection()
    await s.refreshLibrary()
    s.refreshPhotos()
  } catch (e) {
    s.toast('error', e instanceof Error ? e.message : '清空回收站失败')
  }
}
