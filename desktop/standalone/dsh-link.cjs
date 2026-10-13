'use strict'

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')

function loopbackBase(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port
      && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash ? u.origin : null
  } catch { return null }
}

function createDshLink(options = {}) {
  const home = options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const ticketPath = path.join(home, 'dsh-live2d-pet-desktop.json')
  let current = null
  let probing = false
  let stopped = false
  let timer = null
  const streams = new Set()
  const listeners = new Set()
  const readTicket = () => {
    try { return JSON.parse(fs.readFileSync(ticketPath, 'utf8').replace(/^\uFEFF/, '')) } catch { return {} }
  }
  function change(next) {
    if ((current && current.base) === (next && next.base) && (current && current.token) === (next && next.token)) return
    current = next
    for (const stream of streams) stream.destroy()
    streams.clear()
    for (const fn of listeners) fn(status())
  }
  function status() { return { connected: !!current, base: current ? current.base : null } }
  async function refresh() {
    if (probing || stopped) return status()
    probing = true
    try {
      const ticket = readTicket()
      const token = typeof ticket.token === 'string' && /^[a-f0-9]{16,128}$/.test(ticket.token) ? ticket.token : ''
      const preferred = typeof options.preference === 'function' ? options.preference() : 'auto'
      const port = Number(ticket.port)
      const candidates = options.bases || [
        Number.isInteger(port) && port > 0 && port < 65536 ? 'http://127.0.0.1:' + port : null,
        'http://127.0.0.1:19387', 'http://127.0.0.1:3080',
      ]
      const ordered = [...new Set(candidates.map(loopbackBase).filter(Boolean))]
      if (preferred === 'auto' && current) ordered.sort((a) => a === current.base ? -1 : 0)
      for (const base of ordered) {
        try {
          const response = await fetch(base + '/dsh-pet/state', {
            headers: token ? { 'x-dsh-pet-desk': token } : {}, signal: AbortSignal.timeout(1000), redirect: 'error',
          })
          if (!response.ok) continue
          const state = await response.json()
          if (!state.ok || state.standalone || typeof state.status !== 'string') continue
          if (preferred === 'desktop' && !state.desktop) continue
          if (preferred === 'web' && state.desktop) continue
          if (!stopped) change({ base, token })
          return status()
        } catch {}
      }
      if (!stopped) change(null)
      return status()
    } finally { probing = false }
  }
  function forward(req, res) {
    if (!current) return false
    const selected = current
    const upstream = new URL(req.url, selected.base)
    // Never forward cookies, credentials, arbitrary hosts or redirects supplied by the page.
    const headers = {}
    for (const key of ['content-type', 'range', 'accept', 'last-event-id']) {
      if (req.headers[key]) headers[key] = req.headers[key]
    }
    if (selected.token) headers['x-dsh-pet-desk'] = selected.token
    const stream = req.url.split('?')[0] === '/dsh-pet/events'
    const out = http.request(upstream, { method: req.method, headers }, (incoming) => {
      if (stream) out.setTimeout(0)
      const safeHeaders = {}
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
        if (incoming.headers[key]) safeHeaders[key] = incoming.headers[key]
      }
      res.writeHead(incoming.statusCode, safeHeaders)
      incoming.pipe(res)
    })
    if (stream) streams.add(out)
    out.setTimeout(4000, () => out.destroy(new Error('DSH timeout')))
    out.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'dsh-unavailable' }))
      } else res.end()
      if (current === selected) change(null)
    })
    res.on('close', () => { streams.delete(out); out.destroy() })
    req.on('aborted', () => out.destroy())
    req.pipe(out)
    return true
  }
  return {
    status, refresh, forward,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    start: async () => { stopped = false; await refresh(); timer = setInterval(refresh, 3000); timer.unref(); return status() },
    close: () => { stopped = true; clearInterval(timer); change(null); listeners.clear() },
  }
}

module.exports = { createDshLink, loopbackBase }
