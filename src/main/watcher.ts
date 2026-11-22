import chokidar, { type FSWatcher } from 'chokidar'
import { listFolders } from './db'
import { isImagePath, trackChangedFile, trackDeletedFile, trackNewFile } from './scanner'
import { logError } from './log'

const watchers = new Map<number, FSWatcher>()

let reconcileTimer: ReturnType<typeof setTimeout> | null = null

/** 对账补挂：资料库可见但未挂监听的文件夹重新 startWatcher。
 *  覆盖启动挂载遗漏、换库后重建、以及监听条目丢失的恢复；只补缺不重建，
 *  已注册（即使底层报错）的条目不会反复重启。 */
export async function reconcileWatchers(): Promise<void> {
  for (const f of listFolders()) {
    if (watchers.has(f.id)) continue
    await startWatcher(f.id, f.path)
  }
}

/** 错误触发的延迟对账：网络盘断连重连 / 目录重建后自动补挂 */
function scheduleReconcile(delay = 5000): void {
  if (reconcileTimer) return
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null
    void reconcileWatchers().catch((err) => logError('watcher', err))
  }, delay)
}

export async function startWatcher(folderId: number, root: string): Promise<void> {
  if (watchers.has(folderId)) return
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: /(^|[/\\])\../,
    // 不限制监听深度，与 scanner.walk 的无限递归保持一致，避免深层目录成为同步盲区
    awaitWriteFinish: {
      stabilityThreshold: 600,
      pollInterval: 120
    }
  })
  const isImage = isImagePath
  watcher
    .on('add', (p) => {
      if (isImage(p)) void trackNewFile(folderId, p)
    })
    .on('change', (p) => {
      if (isImage(p)) trackChangedFile(folderId, p)
    })
    .on('unlink', (p) => {
      if (isImage(p)) trackDeletedFile(folderId, p)
    })
    .on('error', (err) => {
      logError('watcher', err)
      // 目录被删后重建 / 网络盘抖动：延迟对账补挂缺失条目
      scheduleReconcile()
    })
  watchers.set(folderId, watcher)
}

export async function stopWatcher(folderId: number): Promise<void> {
  const w = watchers.get(folderId)
  if (w) {
    await w.close().catch(() => undefined)
    watchers.delete(folderId)
  }
}

export async function stopAllWatchers(): Promise<void> {
  for (const id of [...watchers.keys()]) {
    await stopWatcher(id)
  }
}
