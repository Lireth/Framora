import { contextBridge, ipcRenderer } from 'electron'

const CALLABLE = new Set([
  'app:info',
  'settings:get',
  'settings:set',
  'dialog:pickFolder',
  'dialog:pickFiles',
  'dialog:pickExportDir',
  'library:listFolders',
  'library:importFolder',
  'library:importFiles',
  'library:rescan',
  'library:removeFolder',
  'library:stats',
  'photos:query',
  'photos:queryIds',
  'photos:get',
  'photos:updateMeta',
  'photos:metadata',
  'photos:delete',
  'photos:export',
  'photos:saveEdits',
  'photos:revert',
  'photos:openInExplorer',
  'photos:regenerateThumb',
  'photos:setTags',
  'photos:batchTags',
  'photos:batchRate',
  'photos:batchAlbum',
  'photos:batchRename',
  'photos:removeAlbum',
  'thumbs:rebuildAll',
  'thumbs:cleanupOrphans',
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
  'smartAlbums:delete',
  'window:setTheme',
  'window:toggleFullscreen',
  'app:openDataDir',
  'app:openThumbsDir',
  'app:clearBackups',
  'app:openLogsDir',
  'app:dragOutPhotos'
])

const EVENTS = new Set(['evt:scan', 'evt:thumb', 'evt:watch', 'evt:library', 'evt:export'])

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
  }
}

contextBridge.exposeInMainWorld('framora', api)

export type FramoraApi = typeof api
