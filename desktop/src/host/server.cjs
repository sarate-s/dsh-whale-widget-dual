// Mini DSH host shim: runs the real dsh-whale-widget host plugin with a minimal
// webServer / credentials / deepseekAccount implementation, then serves its routes
// and the widget page over localhost so an Electron window can display it.
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const APP_ROOT = path.resolve(__dirname, '..', '..')
const VENDOR_DIR = path.join(APP_ROOT, 'vendor', 'dsh-whale-widget')
const RENDERER_DIR = path.join(APP_ROOT, 'src', 'renderer')
const DSH_HOME = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
const DEFAULT_PORT = 38271

// 极简 YAML 读取：只需要 .credentials.yaml 里的 refs/* 与 records/*/payload/*
function readCredentialMap() {
  const file = path.join(DSH_HOME, '.credentials.yaml')
  const map = {}
  let lines = []
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/) } catch (err) { return map }
  const stack = []
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const m = /^(\s*)([^:]+):\s*(.*)$/.exec(raw)
    if (!m) continue
    const indent = m[1].length
    const key = m[2].trim()
    const value = m[3].trim()
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const full = stack.map((s) => s.key).concat(key).join('/')
    if (value) map[full] = value
    else stack.push({ indent, key })
  }
  return map
}

function unquote(value) {
  return String(value || '').replace(/^['"]|['"]$/g, '')
}

function readCredentials() {
  const map = readCredentialMap()
  return {
    apiKey: unquote(map['refs/DEEPSEEK_API_KEY']) || unquote(map['refs/deepseek_api_key']),
    grantToken: unquote(map['records/deepseek-account-platform/default/payload/token']),
    issuer: unquote(map['records/deepseek-account-platform/default/payload/issuer']) || 'https://platform.deepseek.com',
  }
}

function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers, timeout: 12000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null, raw: body })
        } catch (err) {
          resolve({ status: res.statusCode, json: null, raw: body })
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

// DeepSeek Platform 账号余额（与 DSH 的 deepseekAccount 服务同一接口/同一 token）
function createDeepseekAccount({ log }) {
  return {
    getState() { return null },
    async getBalance() {
      const cred = readCredentials()
      if (!cred.grantToken || !cred.issuer) {
        log('account: no grant token')
        return null
      }
      try {
        const origin = cred.issuer.replace(/\/+$/, '')
        const res = await httpsGetJson(origin + '/api/v0/users/get_user_summary', {
          'x-dsh-auth-token': cred.grantToken,
          Accept: 'application/json',
          'User-Agent': 'dsh-whale-widget-desktop',
        })
        if (res.status !== 200 || !res.json) {
          log('account: HTTP ' + res.status)
          return null
        }
        const biz = res.json && res.json.data && res.json.data.biz_data
        if (!biz) {
          log('account: no biz_data')
          return null
        }
        const wallets = (list) => (Array.isArray(list) ? list : [])
          .filter((w) => w && w.currency && w.balance !== undefined && w.balance !== null)
          .map((w) => ({ currency: String(w.currency), balance: String(w.balance) }))
        return {
          status: 'ready',
          value: wallets(biz.normal_wallets),
          bonusWallets: wallets(biz.bonus_wallets),
        }
      } catch (err) {
        log('account: request failed ' + ((err && err.message) || err))
        return null
      }
    },
    async getProfile() { return null },
    async getUnnotifiedBonuses() { return null },
    async ackBonusNotified() { return false },
  }
}

function createHostContext(log) {
  const routes = []
  const indexTransforms = []
  const disposers = []
  const listeners = new Map()
  const account = createDeepseekAccount({ log })

  function on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(cb)
    return () => { try { listeners.get(event).delete(cb) } catch (err) {} }
  }
  function effect(fn) {
    try {
      const dispose = typeof fn === 'function' ? fn() : null
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (err) { log('effect error ' + ((err && err.message) || err)) }
  }

  // 凭据：DSH 官方 YAML 优先，其次本地 sidecar（自定义 API key 面板写入这里）
  const sidecar = path.join(DSH_HOME, '.dshw-desktop-credentials.json')
  let sidecarCache = null
  function loadSidecar() {
    if (sidecarCache) return sidecarCache
    try { sidecarCache = JSON.parse(fs.readFileSync(sidecar, 'utf8')) || {} } catch (err) { sidecarCache = {} }
    return sidecarCache
  }
  function persistSidecar() {
    try {
      fs.mkdirSync(DSH_HOME, { recursive: true })
      fs.writeFileSync(sidecar, JSON.stringify(sidecarCache || {}))
    } catch (err) {}
  }
  const credentials = {
    async resolve(ref) {
      const key = String(ref || '').trim()
      if (!key) return undefined
      if (process.env[key]) return process.env[key]
      const side = loadSidecar()
      if (typeof side[key] === 'string' && side[key]) return side[key]
      const value = readCredentials()[key === 'DEEPSEEK_API_KEY' ? 'apiKey' : '']
      if (value) return value
      // 其他 refs 直接按名字读 YAML
      const map = readCredentialMap()
      const direct = map['refs/' + key]
      return direct ? unquote(direct) : undefined
    },
    async set(ref, value) {
      const key = String(ref || '').trim()
      if (!key) return
      loadSidecar()[key] = String(value)
      persistSidecar()
    },
    async delete(ref) {
      delete loadSidecar()[String(ref || '').trim()]
      persistSidecar()
    },
    async list() { return Object.keys(loadSidecar()) },
  }

  const optional = {
    sessionTitle: { get: () => null },
    deepseekAccount: account,
  }

  const ctx = {
    webServer: {
      register(route) {
        if (!route || typeof route.handler !== 'function') return () => {}
        routes.push(route)
        return () => {
          const i = routes.indexOf(route)
          if (i >= 0) routes.splice(i, 1)
        }
      },
      tapIndex(fn) {
        if (typeof fn === 'function') indexTransforms.push(fn)
        return () => {}
      },
    },
    credentials,
    connection: { requestRejection: () => null },
    on,
    effect,
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'webServer') return ctx.webServer
      if (name === 'connection') return ctx.connection
      return optional[name] || null
    },
  }
  const root = {
    on,
    effect,
    get: ctx.get,
    inject(_deps, cb) {
      try { cb(ctx) } catch (err) { log('inject callback error ' + ((err && err.stack) || err)) }
    },
  }
  return { ctx, root, routes, indexTransforms, disposers, listeners }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  })
}

function findRoute(routes, pathname) {
  for (const route of routes) {
    if (!route || !route.path) continue
    if (route.kind === 'prefix') {
      if (pathname.startsWith(route.path)) return route
    } else if (route.kind === 'exact' || !route.kind) {
      if (pathname === route.path) return route
    }
  }
  return null
}

function readIndexHtml() {
  try { return fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8') } catch (err) { return null }
}

async function startHost({ log = () => {} } = {}) {
  const host = createHostContext(log)
  let plugin
  try {
    plugin = await import(pathToFileURL(path.join(VENDOR_DIR, 'lib', 'index.js')).href)
  } catch (err) {
    log('failed to import widget plugin: ' + ((err && err.stack) || err))
    throw err
  }
  try {
    await plugin.default.apply(host.root)
    log('widget plugin applied, routes=' + host.routes.length)
  } catch (err) {
    log('widget plugin apply failed: ' + ((err && err.stack) || err))
    throw err
  }

  const indexHtml = (() => {
    const raw = readIndexHtml()
    if (!raw) return '<!doctype html><html><body style="background:transparent"><script src="/dsh-whale/widget.js"></script></body></html>'
    let html = raw
    for (const fn of host.indexTransforms) {
      try { const next = fn(html); if (typeof next === 'string') html = next } catch (err) {}
    }
    return html
  })()

  const server = http.createServer((req, res) => {
    try {
      const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(indexHtml)
        return
      }
      if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
      const route = findRoute(host.routes, pathname)
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      const result = route.handler(req, res)
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          log('route error ' + pathname + ': ' + ((err && err.message) || err))
          try { if (!res.headersSent) res.writeHead(500); res.end() } catch (e2) {}
        })
      }
    } catch (err) {
      log('server error: ' + ((err && err.message) || err))
      try { res.writeHead(500); res.end() } catch (e2) {}
    }
  })

  let port = DEFAULT_PORT
  try {
    port = await listen(server, DEFAULT_PORT)
  } catch (err) {
    port = await listen(server, 0)
  }
  log('mini host listening on http://127.0.0.1:' + port)

  function stop() {
    try { server.close() } catch (err) {}
    for (const dispose of host.disposers.splice(0)) { try { dispose() } catch (err) {} }
  }

  return { port, stop, server, routes: host.routes, dshHome: DSH_HOME }
}

module.exports = { startHost, DSH_HOME, VENDOR_DIR }
