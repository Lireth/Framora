import { useEffect } from 'react'
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
import { Toasts } from './components/ui'

export default function App(): React.JSX.Element {
  const theme = useStore((s) => s.theme)
  const detailOpen = useStore((s) => s.detailOpen)
  const viewerOpen = useStore((s) => s.viewerOpen)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

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
            s.toast(
              'success',
              `扫描完成：发现 ${e.found ?? 0} 张，新增 ${e.added ?? 0} 张，更新 ${e.updated ?? 0} 张${
                e.unsupported ? `，另有 ${e.unsupported} 个无法解码的照片未导入` : ''
              }`
            )
          } else {
            s.toast('error', e.message ?? '扫描失败')
          }
          scheduleLibraryRefresh(100)
          schedulePhotosRefresh(150)
        }
      }),
      onEvent('evt:thumb', (d) => pushThumbEvent(d as ThumbEvent)),
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
      if (s.viewerOpen) {
        if (e.key === 'Escape') s.closeViewer()
        else if (e.key === 'ArrowLeft') s.stepViewer(-1)
        else if (e.key === 'ArrowRight') s.stepViewer(1)
        else if (e.key === ' ' && t.tagName !== 'BUTTON') {
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
      <Toasts />
    </div>
  )
}
