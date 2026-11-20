import path from 'node:path'
import chokidar from 'chokidar'
import { IMAGE_EXTS, trackChangedFile, trackDeletedFile, trackNewFile } from './scanner'

const watchers = new Map<number, chokidar.FSWatcher>()

export async function startWatcher(folderId: number, root: string): Promise<void> {
  if (watchers.has(folderId)) return
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: /(^|[/\\])\../,
    depth: 8,
    awaitWriteFinish: {
      stabilityThreshold: 600,
      pollInterval: 120
    }
  })
  const isImage = (p: string) => IMAGE_EXTS.has(path.extname(p).toLowerCase())
  watcher
    .on('add', (p) => {
      if (isImage(p)) trackNewFile(folderId, p)
    })
    .on('change', (p) => {
      if (isImage(p)) trackChangedFile(folderId, p)
    })
    .on('unlink', (p) => {
      if (isImage(p)) trackDeletedFile(folderId, p)
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
