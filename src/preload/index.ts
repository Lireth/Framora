import { contextBridge, ipcRenderer, webUtils } from 'electron'

// 首帧主题：preload 先于页面脚本与首次绘制运行，且不受 CSP 限制。
// 读取 localStorage 镜像（store 每次切换主题时写入）提前应用 .dark 类，
// 消除浅色 / 跟随系统用户的启动主题闪变；无镜像时保持 index.html 默认深色。
try {
  const mode = localStorage.getItem('framora-theme')
  const dark =
    mode === 'light'
      ? false
      : mode === 'system'
        ? matchMedia('(prefers-color-scheme: dark)').matches
        : true
  document.documentElement.classList.toggle('dark', dark)
} catch {
  /* 首次启动无镜像，保持默认 */
}

const CALLABLE = new Set([
  'app:info',
  'settings:get',
  'settings:set',
  'storage:stats',
  'storage:setLimits',
  'storage:cleanPreviews',
  'storage:enforce',
  'dialog:pickFolder',
  'dialog:pickFiles',
  'dialog:pickExportDir',
  'library:listFolders',
  'library:importFolder',
  'library:importFiles',
  'library:rescan',
  'library:cancelScan',
  'library:removeFolder',
  'library:stats',
  'library:exportBackup',
  'library:importBackup',
  'undo:peek',
  'undo:perform',
  'duplicates:selectRedundant',
  'duplicates:setThreshold',
  'photos:query',
  'photos:geo',
  'photos:queryIds',
  'photos:get',
  'photos:updateMeta',
  'photos:metadata',
  'photos:delete',
  'photos:restore',
  'photos:purge',
  'photos:emptyTrash',
  'photos:export',
  'photos:cancelExport',
  'photos:saveEdits',
  'photos:revert',
  'photos:listBackups',
  'photos:openInExplorer',
  'photos:openInMap',
  'photos:regenerateThumb',
  'photos:setTags',
  'photos:batchTags',
  'photos:batchRate',
  'photos:batchAlbum',
  'photos:batchRename',
  'photos:removeAlbum',
  'thumbs:rebuildAll',
  'thumbs:cleanupOrphans',
  'thumbs:clearQueue',
  'tags:list',
  'tags:create',
  'tags:rename',
  'tags:setColor',
  'tags:delete',
  'albums:list',
  'albums:create',
  'albums:rename',
  'albums:setColor',
  'albums:delete',
  'smartAlbums:list',
  'smartAlbums:create',
  'smartAlbums:rename',
  'smartAlbums:update',
  'smartAlbums:delete',
  'window:setTheme',
  'window:minimize',
  'window:maximizeToggle',
  'window:isMaximized',
  'window:close',
  'window:toggleFullscreen',
  'app:openDataDir',
  'app:openThumbsDir',
  'app:clearBackups',
  'app:cleanupOrphanBackups',
  'app:openLogsDir',
  'app:dragOutPhotos',
  'update:check',
  'update:download',
  'update:cancelDownload',
  'update:install',
  'update:getState',
])

const EVENTS = new Set([
  'evt:scan',
  'evt:thumbBatch',
  'evt:watch',
  'evt:library',
  'evt:export',
  'evt:update',
  'evt:maximize',
])

const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (!CALLABLE.has(channel)) {
      return Promise.reject(new Error(`未授权的 IPC 通道: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel: string, callback: (data: unknown) => void): (() => void) => {
    if (!EVENTS.has(channel)) return () => undefined
    const listener = (_e: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
  /**
   * 拖入文件/文件夹的绝对路径。Electron 32 起 File.path 已移除，必须经 webUtils 解析；
   * 无路径（浏览器合成 File、受保护虚拟文件）时返回空串，由调用方跳过。
   */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
}

contextBridge.exposeInMainWorld('framora', api)

export type FramoraApi = typeof api
