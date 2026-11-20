/**
 * 应用内更新通道（隐私优先设计）：
 * - 不做任何自动检查/自动下载：仅当用户在「设置 → 关于」显式点击检查时才访问网络
 * - 下载源为 GitHub Releases（electron-builder publish 配置在打包期写入 app-update.yml）
 * - 全程用户确认：检查 → 下载（带进度/可取消）→ 安装并重启
 */
import { app, BrowserWindow } from 'electron'
import { autoUpdater, CancellationToken, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { logError } from './log'
import type { UpdateCheckResult, UpdateEvent, UpdateState } from '@shared/types'

let state: UpdateState = { phase: 'idle' }
let downloadToken: CancellationToken | null = null

function broadcast(e: UpdateEvent): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('evt:update', e)
}

function setState(next: UpdateState): void {
  state = next
  // idle 仅作为初始快照相位，无需广播
  if (next.phase !== 'idle') {
    broadcast({
      phase: next.phase,
      version: next.version,
      percent: next.percent,
      message: next.message
    })
  }
}

/** 三段数字版本号比较（仅用于本项目自发布的 x.y.z 版本） */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] => v.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const [la, lb, lc] = parse(latest)
  const [ca, cb, cc] = parse(current)
  if (la !== ca) return la > ca
  if (lb !== cb) return lb > cb
  return lc > cc
}

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false

autoUpdater.on('update-available', (info: UpdateInfo) => {
  setState({ phase: 'available', version: info.version })
})
autoUpdater.on('update-not-available', () => {
  setState({ phase: 'up-to-date' })
})
autoUpdater.on('download-progress', (p: ProgressInfo) => {
  setState({ phase: 'downloading', percent: Math.min(100, Math.round(p.percent)) })
})
autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
  downloadToken = null
  setState({ phase: 'downloaded', version: info.version })
})
autoUpdater.on('error', (err: Error) => {
  downloadToken = null
  logError('updater', err)
  setState({ phase: 'error', message: err.message })
})

/** 手动检查更新：开发模式下直接返回 dev 态（无打包期生成的 app-update.yml） */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) return { status: 'dev' }
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) throw new Error('更新服务未返回有效信息')
    const latest = result.updateInfo.version
    if (isNewerVersion(latest, app.getVersion())) {
      return { status: 'available', version: latest }
    }
    return { status: 'up-to-date' }
  } catch (err) {
    logError('updater', err)
    return { status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

/** 下载更新（需先完成检查）；进度经 evt:update 推送，可取消 */
export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) return
  if (state.phase !== 'available') throw new Error('请先检查更新')
  downloadToken = new CancellationToken()
  try {
    await autoUpdater.downloadUpdate(downloadToken)
  } catch (err) {
    // 取消以 CancellationError 形式抛出：恢复到可重新下载的状态即可
    if (downloadToken?.cancelled) {
      downloadToken = null
      setState({ phase: 'available', version: state.version })
      return
    }
    throw err
  }
}

export function cancelUpdateDownload(): void {
  downloadToken?.cancel()
}

/** 安装并重启（NSIS 向导模式，完成后自动拉起应用） */
export function installUpdate(): void {
  if (!app.isPackaged) return
  autoUpdater.quitAndInstall(false, true)
}

export function getUpdateState(): UpdateState {
  return state
}
