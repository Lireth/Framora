import { contextBridge, ipcRenderer } from 'electron'

const CALLABLE = new Set([
  'app:info',
  'settings:get',
  'settings:set',
  'dialog:pickFolder',
  'dialog:pickExportDir',
  'library:listFolders',
  'library:importFolder',
  'library:rescan',
  'library:removeFolder',
  'library:stats',
  'photos:query',
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
  'photos:removeAlbum',
  'thumbs:rebuildAll',
  'tags:list',
  'tags:create',
  'tags:rename',
  'tags:delete',
  'albums:list',
  'albums:create',
  'albums:rename',
  'albums:delete',
  'window:setTheme',
  'app:openDataDir',
  'app:openThumbsDir'
])

const EVENTS = new Set(['evt:scan', 'evt:thumb', 'evt:watch', 'evt:library'])

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
