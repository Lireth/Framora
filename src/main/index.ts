import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow, Menu, app, dialog, net, protocol, screen } from 'electron'
import { pathToFileURL } from 'node:url'
import { initDb, closeDb, getSetting, setSetting, listFolders, listFolderPaths, listPhotoIdsPendingThumb } from './db'
import { registerIpc } from './ipc'
import { isImagePath } from './scanner'
import { startWatcher, stopAllWatchers } from './watcher'
import { thumbsDir, enqueueThumb } from './thumbs'

const isDev = !app.isPackaged

// 测试隔离：允许通过环境变量重定向 userData 目录（冒烟测试避免污染真实资料库）
if (process.env['FRAMORA_USER_DATA']) {
  app.setPath('userData', process.env['FRAMORA_USER_DATA'])
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

let win: BrowserWindow | null = null

const DEFAULT_WIDTH = 1360
const DEFAULT_HEIGHT = 860

interface SavedBounds {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

function loadWindowBounds(): SavedBounds | null {
  try {
    const raw = getSetting('windowBounds')
    if (!raw) return null
    const b = JSON.parse(raw) as Partial<SavedBounds>
    if (
      typeof b.width !== 'number' ||
      typeof b.height !== 'number' ||
      b.width < 1000 ||
      b.height < 640
    ) {
      return null
    }
    return {
      width: Math.round(b.width),
      height: Math.round(b.height),
      x: typeof b.x === 'number' ? Math.round(b.x) : 0,
      y: typeof b.y === 'number' ? Math.round(b.y) : 0,
      maximized: b.maximized === true
    }
  } catch {
    return null
  }
}

/** 保存的位置必须仍落在某个显示器的可视区域内，否则丢弃（如拔掉外接显示器） */
function isOnSomeDisplay(x: number, y: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return x >= a.x - 40 && x < a.x + a.width && y >= a.y - 40 && y < a.y + a.height
  })
}

function createWindow(): void {
  const saved = loadWindowBounds()
  const usePosition = saved ? isOnSomeDisplay(saved.x, saved.y) : false
  win = new BrowserWindow({
    width: saved?.width ?? DEFAULT_WIDTH,
    height: saved?.height ?? DEFAULT_HEIGHT,
    ...(usePosition ? { x: saved!.x, y: saved!.y } : {}),
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#101014',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#101014',
      symbolColor: '#e7e8ea',
      height: 40
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => {
    if (saved?.maximized) win?.maximize()
    win?.show()
  })
  win.on('close', () => {
    if (!win) return
    try {
      const b = win.getBounds()
      setSetting(
        'windowBounds',
        JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() })
      )
    } catch {
      /* 关闭时保存失败可忽略 */
    }
  })
  win.on('closed', () => {
    win = null
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    if (process.env['FRAMORA_DEVTOOLS']) {
      win.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/** 校验路径位于已注册资料库文件夹内（media 协议纵深防御，防止任意路径读取） */
function isInsideLibrary(p: string): boolean {
  const resolved = path.resolve(p).toLowerCase()
  const sep = path.sep
  for (const root of listFolderPaths()) {
    const r = path.resolve(root).toLowerCase()
    const prefix = r.endsWith(sep) ? r : r + sep
    if (resolved.startsWith(prefix)) return true
  }
  return false
}

/** 读取本地文件并附加缓存头（media/thumb 的 URL 均带版本参数，可安全 immutable） */
async function fileResponse(p: string): Promise<Response> {
  const resp = await net.fetch(pathToFileURL(p).toString())
  const headers = new Headers(resp.headers)
  headers.set('Cache-Control', 'private, max-age=31536000, immutable')
  return new Response(resp.body, { status: resp.status, headers })
}

function registerProtocols(): void {
  protocol.handle('media', async (req) => {
    try {
      const u = new URL(req.url)
      const p = decodeURIComponent(u.searchParams.get('p') ?? '')
      if (
        !p ||
        !isImagePath(p) ||
        !isInsideLibrary(p) ||
        !fs.existsSync(p) ||
        !fs.statSync(p).isFile()
      ) {
        return new Response(null, { status: 404 })
      }
      return await fileResponse(p)
    } catch {
      return new Response(null, { status: 400 })
    }
  })

  protocol.handle('thumb', async (req) => {
    try {
      const u = new URL(req.url)
      const name = u.hostname === 't' ? u.pathname.slice(1) : u.hostname + u.pathname
      if (!/^\d+\.webp$/.test(name)) return new Response(null, { status: 400 })
      const p = path.join(thumbsDir(), name)
      if (!fs.existsSync(p)) return new Response(null, { status: 404 })
      return await fileResponse(p)
    } catch {
      return new Response(null, { status: 400 })
    }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.setAppUserModelId('com.framora.desktop')
  Menu.setApplicationMenu(null)

  app.whenReady().then(async () => {
    try {
      await initDb()
    } catch (err) {
      // 兜底重试仍失败：提示后退出，避免带病运行
      dialog.showMessageBoxSync({
        type: 'error',
        title: '拾帧 Framora',
        message: '索引库初始化失败，应用即将退出。',
        detail: err instanceof Error ? err.message : String(err)
      })
      app.quit()
      return
    }
    registerProtocols()
    registerIpc()
    createWindow()
    // 恢复已有文件夹的文件监听
    for (const f of listFolders()) {
      if (fs.existsSync(f.path)) startWatcher(f.id, f.path)
    }
    // 续跑上次未完成的缩略图生成（崩溃/退出遗留的 thumb_status=0）
    for (const id of listPhotoIdsPendingThumb()) {
      enqueueThumb(id)
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    stopAllWatchers()
    closeDb()
  })
}
