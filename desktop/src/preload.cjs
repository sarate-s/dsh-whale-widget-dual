// 渲染层 → 主进程：上报「挂件可交互区域」，主进程据此切换点击穿透。
// dsh-whale-widget 的 .dshwv-root 本身 pointer-events:none（子元素 auto），
// 所以不能只看 pointer-events；这里按顶层容器类名+可见性收集矩形。
const { ipcRenderer } = require('electron')

const INTERACTIVE_CLASS = /dshwv-(root|menu|pop|bub|role|audio|crop|confirm|snap|frame|qedit|usage|res|cust|cp-badge)/

function rectOf(el) {
  try {
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden') return null
    const opacity = Number(s.opacity)
    if (isFinite(opacity) && opacity < 0.05) return null
    const r = el.getBoundingClientRect()
    if (!(r.width > 2 && r.height > 2)) return null
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  } catch (err) { return null }
}

function mergeRects(rects) {
  const out = []
  for (const r of rects) {
    let merged = false
    for (const o of out) {
      const overlap = !(r.x + r.w < o.x || o.x + o.w < r.x || r.y + r.h < o.y || o.y + o.h < r.y)
      if (overlap) {
        const x1 = Math.min(o.x, r.x), y1 = Math.min(o.y, r.y)
        const x2 = Math.max(o.x + o.w, r.x + r.w), y2 = Math.max(o.y + o.h, r.y + r.h)
        o.x = x1; o.y = y1; o.w = x2 - x1; o.h = y2 - y1
        merged = true
        break
      }
    }
    if (!merged) out.push(Object.assign({}, r))
  }
  return out
}

function collectRects() {
  const rects = []
  const root = document.querySelector('.dshwv-root')
  const rootRect = root ? rectOf(root) : null
  if (rootRect) rects.push(rootRect)
  for (const el of document.querySelectorAll('[class*="dshwv"]')) {
    if (el === root) continue
    if (el.parentElement !== document.body) continue
    const cls = String(el.className || '')
    if (!INTERACTIVE_CLASS.test(cls)) continue
    if (cls.indexOf('dshwv-cp-fx') >= 0) continue // 全屏粒子装饰层，不接收点击
    const r = rectOf(el)
    if (r) rects.push(r)
  }
  return mergeRects(rects).slice(0, 24)
}

let lastJson = ''
function report() {
  let rects = []
  try { rects = collectRects() } catch (err) {}
  const json = JSON.stringify(rects)
  if (json !== lastJson) {
    lastJson = json
    try { ipcRenderer.send('shell:rects', rects) } catch (err) {}
  }
}

let busy = false
function setBusy(v) {
  if (busy === v) return
  busy = v
  try { ipcRenderer.send('shell:busy', v) } catch (err) {}
}

window.addEventListener('DOMContentLoaded', () => {
  report()
  setInterval(report, 150)
  document.addEventListener('pointerdown', () => setBusy(true), true)
  document.addEventListener('pointerup', () => setBusy(false), true)
  document.addEventListener('pointercancel', () => setBusy(false), true)
  window.addEventListener('blur', () => setBusy(false))
  window.addEventListener('resize', report)
})
