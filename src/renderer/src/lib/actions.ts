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
    s.toast(
      'success',
      `导入完成：发现 ${r.found} 张，新增 ${r.added} 张，更新 ${r.updated} 张`
    )
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

/** 删除（移入回收站）所选照片 */
export async function deletePhotosAction(ids: number[]): Promise<void> {
  if (!ids.length) return
  const s = useStore.getState()
  try {
    const r = await api.deletePhotos(ids)
    if (r.failed > 0) {
      s.toast('error', `已删除 ${r.deleted} 张，${r.failed} 张删除失败`)
    } else {
      s.toast('success', `已将 ${r.deleted} 张照片移入回收站`)
    }
    s.clearSelection()
    if (s.viewerOpen) s.closeViewer()
    await s.refreshLibrary()
    s.refreshPhotos()
  } catch (e) {
    s.toast('error', e instanceof Error ? e.message : '删除失败')
  }
}
