// DSH Whale Widget Desktop — 把完整版 dsh-whale-widget 装进独立 Electron 桌面窗。
// 主进程负责：启动 mini-host（真实插件宿主 + 本地 HTTP 服务）→ 全屏透明置顶窗加载挂件 →
// 轮询指针做点击穿透；托盘提供退出/重载/开机自启。
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, dialog, nativeImage, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { startHost } = require('./host/server.cjs')

const APP_ROOT = path.resolve(__dirname, '..')
const ASSETS = path.join(APP_ROOT, 'assets')
const AUTO_NAME = 'DshWhaleDesktop'
const DEBUG = process.argv.includes('--whale-debug') || process.env.DSH_WHALE_DEBUG === '1'
const HIT_TEST_MS = 60

let win = null
let tray = null
let host = null
let ignoring = true
let interactiveRects = []
let busy = false
let busyTimer = null
let pollTimer = null

function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  if (DEBUG) {
    try {
      const file = path.join(app.getPath('userData'), 'debug.log')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, line + '\n')
    } catch (err) {}
  }
  try { console.log(line) } catch (err) {}
}

// ---------- 开机自启 ----------
function autoCommand() {
  if (app.isPackaged) return '"' + process.execPath + '"'
  return '"' + process.execPath + '" "' + APP_ROOT + '"'
}
function isAutoStart() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', AUTO_NAME], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.indexOf(AUTO_NAME) >= 0
  } catch (err) { return false }
}
function setAutoStart(on) {
  try {
    if (on) {
      execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', AUTO_NAME, '/t', 'REG_SZ', '/d', autoCommand(), '/f'], { stdio: 'ignore' })
    } else {
      execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', AUTO_NAME, '/f'], { stdio: 'ignore' })
    }
    return true
  } catch (err) { return false }
}

function setIgnore(next) {
  if (next === ignoring) return
  ignoring = next
  try { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignoring) } catch (err) {}
}

function hitTest(cursor) {
  const b = win.getBounds()
  const x = cursor.x - b.x
  const y = cursor.y - b.y
  for (const r of interactiveRects) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true
  }
  return false
}

function startHitTestPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    try {
      if (!win || win.isDestroyed()) return
      if (busy) { setIgnore(false); return }
      setIgnore(!hitTest(screen.getCursorScreenPoint()))
    } catch (err) {}
  }, HIT_TEST_MS)
  if (pollTimer.unref) pollTimer.unref()
}

function createWindow(port) {
  const area = screen.getPrimaryDisplay().workArea
  win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true)
  ignoring = true
  win.loadURL('http://127.0.0.1:' + port + '/')
  win.once('ready-to-show', () => {
    try { win.showInactive() } catch (err) {}
  })
  win.webContents.on('render-process-gone', (_e, details) => log('renderer gone', details))
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url))
  win.webContents.on('console-message', (_e, level, message) => log('renderer console[' + level + ']', message))
  win.on('closed', () => { win = null })
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(ASSETS, 'icon.png'))
    tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(path.join(ASSETS, 'icon.ico')) : img)
    tray.setToolTip('DSH 鲸鱼挂件（桌面版）')
    const rebuild = () => {
      const menu = Menu.buildFromTemplate([
        { label: '重新加载挂件', click: () => { try { if (win) win.reload() } catch (err) {} } },
        { label: '打开配置文件目录', click: () => { try { shell.openPath(app.getPath('userData')) } catch (err) {} } },
        { type: 'separator' },
        { label: '开机自启', type: 'checkbox', checked: isAutoStart(), click: (item) => { setAutoStart(!!item.checked); rebuild() } },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ])
      tray.setContextMenu(menu)
    }
    rebuild()
    tray.on('double-click', () => { try { if (win) win.reload() } catch (err) {} })
  } catch (err) { log('tray failed', err) }
}

function stopHost() {
  try { if (host) host.stop() } catch (err) {}
  host = null
}

let ctx = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { try { win.showInactive() } catch (err) {} }
  })

  app.whenReady().then(async () => {
    ctx = { app }
    // 静默开关开机自启（供安装/卸载脚本使用）
    if (process.argv.includes('autostart-on')) { setAutoStart(true); app.quit(); return }
    if (process.argv.includes('autostart-off')) { setAutoStart(false); app.quit(); return }

    log('starting desktop widget', APP_ROOT, process.argv.join(' '))
    try {
      host = await startHost({ log })
    } catch (err) {
      dialog.showErrorBox('DSH Whale Widget Desktop', '插件宿主启动失败：\n' + ((err && err.message) || err))
      app.quit()
      return
    }

    ipcMain.on('shell:rects', (_event, rects) => {
      interactiveRects = (Array.isArray(rects) ? rects : []).filter((r) => (
        r && ['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number' && isFinite(r[k]))
      ))
    })
    ipcMain.on('shell:busy', (_event, value) => {
      busy = !!value
      if (busyTimer) clearTimeout(busyTimer)
      if (busy) busyTimer = setTimeout(() => { busy = false; setIgnore(true) }, 8000)
    })

    createWindow(host.port)
    startHitTestPolling()
    createTray()
    log('host port', host.port)

    app.on('activate', () => { if (win) { try { win.showInactive() } catch (err) {} } })
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => { stopHost() })
}
