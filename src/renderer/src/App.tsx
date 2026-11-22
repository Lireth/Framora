import { useEffect, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { useStore, scheduleLibraryRefresh, schedulePhotosRefresh, pushThumbEvent } from './store'
import { onEvent } from './lib/api'
import type { ScanEvent, ThumbEvent, WatchEvent } from '@shared/types'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { PhotoGrid } from './components/PhotoGrid'
import { StatusBar } from './components/StatusBar'
import { DetailPanel } from './components/DetailPanel'
import { BatchBar } from './components/BatchBar'
import { Viewer } from './components/Viewer'
import { SettingsModal } from './components/SettingsModal'
import { ExportDialog } from './components/ExportDialog'
import { ShortcutHelpModal, Toasts } from './components/ui'
import {
  deleteViewerPhotoAction,
  importDroppedPaths,
  rateGridPhotosAction,
  rateViewerPhotoAction,
} from './lib/actions'

export default function App(): React.JSX.Element {
  const resolvedTheme = useStore((s) => s.resolvedTheme)
  const detailOpen = useStore((s) => s.detailOpen)
  const viewerOpen = useStore((s) => s.viewerOpen)
  const [dropActive, setDropActive] = useState(false)
  /** dragenter/dragleave 成对计数：仅在真正离开窗口时收起投放层 */
  const dropDepth = useRef(0)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark')
  }, [resolvedTheme])

  /* 资源管理器拖放导入：拖入文件/文件夹时显示投放提示，松开后复用导入管线；
     应用自身的照片拖拽（原生 OS 拖拽）不触发导入。始终 preventDefault，避免
     Chromium 把拖入文件当作导航目标打开。 */
  useEffect(() => {
    const isPhotoDrag = (): boolean => {
      const d = useStore.getState().draggingPhotos
      return !!d && Date.now() - d.at < 10000
    }
    const hasFiles = (e: DragEvent): boolean =>
      Array.from(e.dataTransfer?.types ?? []).some((t) => t.toLowerCase() === 'files')

    const onDragEnter = (e: DragEvent): void => {
      if (!hasFiles(e) || isPhotoDrag()) return
      e.preventDefault()
      dropDepth.current++
      setDropActive(true)
    }
    const onDragOver = (e: DragEvent): void => {
      e.preventDefault()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = hasFiles(e) && !isPhotoDrag() ? 'copy' : 'none'
      }
    }
    const onDragLeave = (): void => {
      dropDepth.current = Math.max(0, dropDepth.current - 1)
      if (dropDepth.current === 0) setDropActive(false)
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      dropDepth.current = 0
      setDropActive(false)
      const s = useStore.getState()
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (!files.length) return
      const paths: string[] = []
      for (const f of files) {
        const p = window.framora.getPathForFile(f)
        if (p) paths.push(p)
      }
      if (!paths.length) {
        s.toast('error', '无法读取拖入内容的路径')
        return
      }

      const dragging = s.draggingPhotos
      if (dragging && Date.now() - dragging.at < 10000) {
        const known = new Set(dragging.paths.map((p) => p.toLowerCase()))
        const dropped = paths.map((p) => p.toLowerCase())
        // 路径未覆盖全部拖拽项（跨页选择）时无法精确比对，按应用内拖拽处理
        const incomplete = dragging.paths.length < dragging.ids.length
        // 应用内照片拖拽回落到窗口空白处：拖入路径全部属于本次拖拽，不当作文件导入
        if (incomplete || !known.size || dropped.every((p) => known.has(p))) {
          s.setDraggingPhotos(null)
          return
        }
      }
      s.setDraggingPhotos(null)
      void importDroppedPaths(paths)
    }

    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [])

  /* 初始化 + 主进程事件订阅 */
  useEffect(() => {
    useStore.getState().init()
    const unsubs = [
      onEvent('evt:scan', (d) => {
        const e = d as ScanEvent
        const s = useStore.getState()
        if (e.phase === 'start') {
          s.setScan({ active: true, label: '正在扫描文件夹…' })
        } else if (e.phase === 'progress') {
          s.setScan({ active: true, label: `正在扫描… 已处理 ${e.processed ?? 0} 张` })
        } else {
          s.setScan({ active: false, label: '' })
          if (e.phase === 'done') {
            if (e.cancelled) {
              s.toast('info', `扫描已取消（已发现 ${e.found ?? 0} 张，未建立索引）`)
            } else {
              s.toast(
                'success',
                `扫描完成：发现 ${e.found ?? 0} 张，新增 ${e.added ?? 0} 张，更新 ${e.updated ?? 0} 张${
                  e.unsupported ? `，另有 ${e.unsupported} 个无法解码的照片未导入` : ''
                }${e.missing ? `，标记缺失 ${e.missing} 张` : ''}`
              )
              scheduleLibraryRefresh(100)
              schedulePhotosRefresh(150)
            }
          } else {
            s.toast('error', e.message ?? '扫描失败')
            scheduleLibraryRefresh(100)
            schedulePhotosRefresh(150)
          }
        }
      }),
      onEvent('evt:thumbBatch', (d) => pushThumbEvent(d as ThumbEvent[])),
      onEvent('evt:export', (d) => useStore.getState().setExportProgress(d as { done: number; total: number })),
      onEvent('evt:watch', (d) => {
        const e = d as WatchEvent
        scheduleLibraryRefresh(500)
        schedulePhotosRefresh(500)
        if (e.type === 'unlink') {
          useStore.getState().toast('info', '检测到文件被移除，已标记为缺失')
        }
      }),
      onEvent('evt:library', () => {
        scheduleLibraryRefresh(200)
        schedulePhotosRefresh(250)
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  /* 全局键盘快捷键 */
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (s.helpOpen) {
        if (e.key === 'Escape') s.setHelpOpen(false)
        return
      }
      if (s.settingsOpen || s.exportOpen || s.confirmDeleteOpen) return
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        s.setHelpOpen(true)
        return
      }
      if (s.viewerOpen) {
        if (e.key === 'Escape') s.closeViewer()
        else if (e.key === 'ArrowLeft') s.stepViewer(-1)
        else if (e.key === 'ArrowRight') s.stepViewer(1)
        else if (e.ctrlKey || e.metaKey || e.altKey) return
        else if (e.key === 'Home') {
          e.preventDefault()
          void s.jumpViewer('first')
        } else if (e.key === 'End') {
          e.preventDefault()
          void s.jumpViewer('last')
        } else if (e.key === 'Delete') {
          e.preventDefault()
          void deleteViewerPhotoAction()
        } else if (e.key >= '1' && e.key <= '5') {
          e.preventDefault()
          void rateViewerPhotoAction(Number(e.key))
        } else if (e.key === 'i') {
          e.preventDefault()
          s.toggleDetail()
        } else if (e.key === ' ' && t.tagName !== 'BUTTON') {
          e.preventDefault()
          s.closeViewer()
        }
        return
      }
      if (s.settingsOpen || s.exportOpen || s.confirmDeleteOpen) return
      if (e.key === 'Escape') {
        if (s.selection.size) s.clearSelection()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        s.selectAll()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        s.navigateGrid(-1, 0)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        s.navigateGrid(1, 0)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        s.navigateGrid(0, -1)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        s.navigateGrid(0, 1)
      } else if (e.key === 'Delete' && s.selection.size) {
        s.setConfirmDeleteOpen(true)
      } else if (e.key === 'Enter' && s.selection.size === 1) {
        s.openViewer([...s.selection][0])
      } else if (e.key >= '0' && e.key <= '5' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // 网格快速评分：多选作用于全部选中项，否则作用于锚点照片（0 清除）
        e.preventDefault()
        void rateGridPhotosAction(Number(e.key))
      } else if (e.key === ' ' && t.tagName !== 'BUTTON') {
        e.preventDefault()
        if (s.selection.size === 1) s.openViewer([...s.selection][0])
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="flex h-full flex-col bg-app text-ink">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Toolbar />
          <PhotoGrid />
          <StatusBar />
        </div>
        {detailOpen && <DetailPanel />}
      </div>
      <BatchBar />
      {viewerOpen && <Viewer />}
      <SettingsModal />
      <ExportDialog />
      <ShortcutHelpModal />
      {dropActive && (
        <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-black/45 backdrop-blur-[2px] animate-fadeIn">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-[var(--c-accent)] bg-raised px-12 py-9 text-center shadow-2xl">
            <ImagePlus size={34} className="text-accent" />
            <p className="text-sm font-medium">松开以导入照片</p>
            <p className="max-w-[320px] text-[12px] leading-5 text-ink3">
              文件夹将加入资料库并自动扫描；照片自动分流
            </p>
          </div>
        </div>
      )}
      <Toasts />
    </div>
  )
}
