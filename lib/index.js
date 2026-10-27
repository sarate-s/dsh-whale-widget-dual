// dsh-whale-widget-dual：把小鲸鱼全功能插件改成 dsh-pet 式双模式。
//
//   display = "web"      → 只挂 DSH 页面（浏览器 overlay，全功能）
//   display = "desktop"  → 只拉起桌面 Electron 桌宠（全功能桌面版）
//   display = "both"     → 两者都显示（默认）
//   display = "none"     → 都不显示
//
// 网页半侧 = 本包内的 web-host.js（原 dsh-whale-widget 宿主，未改）
// 桌面半侧 = 本包内置 desktop/（原桌面 exe 应用，桌宠功能不变）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import webHost from './web-host.js'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(LIB_DIR, '..')
const DESKTOP_APP = path.join(PKG_ROOT, 'desktop')
const DSH_HOME = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'dsh-whale-widget-dual.json')
const PID_FILE = path.join(DSH_HOME, 'dsh-whale-widget-dual.pid')
const LOG_FILE = path.join(DSH_HOME, 'dsh-whale-widget-dual.log')

let pet = null
let petPid = null

function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch (err) {}
}

function readDisplay() {
  let display = 'both'
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ display: 'both' }, null, 2))
      log('created default config', CONFIG_FILE)
    } else {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''))
      const value = String((raw && raw.display) || '').trim()
      if (['web', 'desktop', 'both', 'none'].includes(value)) display = value
    }
  } catch (err) {
    log('read config failed, fallback both: ' + ((err && err.message) || err))
  }
  return display
}

function readPidFile() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim())
    return isFinite(pid) && pid > 0 ? pid : null
  } catch (err) { return null }
}
function isAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (err) { return false }
}
function writePid(pid) {
  try { fs.writeFileSync(PID_FILE, String(pid)) } catch (err) {}
}
function removePidFile(pid) {
  try {
    const current = readPidFile()
    if (!pid || current === pid) fs.rmSync(PID_FILE, { force: true })
  } catch (err) {}
}

function findElectron() {
  const candidates = [
    process.env.DSH_WHALE_ELECTRON_PATH,
    process.env.DSH_PET_ELECTRON_PATH,
    path.join(DSH_HOME, 'electron', 'electron.exe'),
    path.join(os.homedir(), '.dsh', 'electron', 'electron.exe'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate } catch (err) {}
  }
  return null
}

function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      try { process.kill(-pid, 'SIGTERM') } catch (err) { process.kill(pid, 'SIGTERM') }
    }
  } catch (err) {}
}

function spawnDesktop() {
  const existing = readPidFile()
  if (existing && isAlive(existing)) { log('desktop pet already running pid=' + existing + '; skip spawn'); petPid = existing; return }
  if (pet && petPid && isAlive(petPid)) { log('desktop pet in memory pid=' + petPid + '; skip spawn'); return }
  const electron = findElectron()
  if (!electron) { log('Electron runtime not found; desktop mode unavailable'); return }
  try {
    const env = Object.assign({}, process.env)
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, [DESKTOP_APP], { env, detached: true, stdio: 'ignore', windowsHide: true })
    pet = child
    petPid = child.pid
    writePid(petPid)
    log('desktop pet spawned pid=' + petPid + ' electron=' + electron)
    child.on('exit', (code) => { log('desktop pet exited code=' + code); if (pet === child) { pet = null; removePidFile(petPid); petPid = null } })
    child.on('error', (err) => { log('desktop pet spawn error ' + ((err && err.message) || err)); pet = null; petPid = null; removePidFile() })
    child.unref()
  } catch (err) {
    log('spawn desktop failed ' + ((err && err.stack) || err))
  }
}

function killPet() {
  const pid = petPid || readPidFile()
  log('dispose: killing desktop pet pid=' + pid)
  killTree(pid)
  removePidFile(pid)
  pet = null
  petPid = null
}

export default {
  name: 'dsh-whale-widget-dual',
  apply(root) {
    const display = readDisplay()
    log('apply display=' + display)

    // 网页半侧：原 dsh-whale-widget 宿主（同步 apply，注入行会在启动收集前登记）
    if (display === 'web' || display === 'both') {
      try {
        webHost.apply(root)
        log('web half applied (dsh-whale-widget)')
      } catch (err) {
        log('web half failed: ' + ((err && err.stack) || err))
      }
    }

    // 桌面半侧：内置桌面桌宠（和之前 exe 完全相同）
    if (display === 'desktop' || display === 'both') {
      try { spawnDesktop() } catch (err) { log('desktop spawn failed ' + err) }
    } else {
      const pid = readPidFile()
      if (pid) { log('display excludes desktop; stop pid=' + pid); killTree(pid); removePidFile(pid) }
    }

    root.effect(() => () => {
      try { killPet() } catch (err) { log('killPet failed ' + err) }
    })
  },
}
