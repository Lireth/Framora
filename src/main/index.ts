import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow, Menu, app, net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { initDb, closeDb, getSetting, listFolders } from './db'
import { registerIpc } from './ipc'
import { isImagePath } from './scanner'
import { startWatcher, stopAllWatchers } from './watcher'
import { thumbPath, thumbsDir } from './thumbs'

const isDev = !app.isPackaged

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
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

  win.on('ready-to-show', () => win?.show())
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

function registerProtocols(): void {
  protocol.handle('media', (req) => {
    try {
      const u = new URL(req.url)
      const p = decodeURIComponent(u.searchParams.get('p') ?? '')
      if (!p || !isImagePath(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
        return new Response(null, { status: 404 })
      }
      return net.fetch(pathToFileURL(p).toString())
    } catch {
      return new Response(null, { status: 400 })
    }
  })

  protocol.handle('thumb', (req) => {
    try {
      const u = new URL(req.url)
      const name = u.hostname === 't' ? u.pathname.slice(1) : u.hostname + u.pathname
      if (!/^\d+\.webp$/.test(name)) return new Response(null, { status: 400 })
      const p = path.join(thumbsDir(), name)
      if (!fs.existsSync(p)) return new Response(null, { status: 404 })
      return net.fetch(pathToFileURL(p).toString())
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

  app.whenReady().then(() => {
    initDb()
    registerProtocols()
    registerIpc()
    createWindow()
    // 恢复已有文件夹的文件监听
    for (const f of listFolders()) {
      if (fs.existsSync(f.path)) startWatcher(f.id, f.path)
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
