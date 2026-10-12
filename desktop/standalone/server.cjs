// ============================================================================
// server.mjs —— 独立桌宠壳的本地迷你服务（**只监听 127.0.0.1**）
// ----------------------------------------------------------------------------
// 为什么需要它：桌宠前端（pet.js）是按 `/dsh-pet/*` 这套路径写的 —— 模型、运行时、
// 事件流、媒体会话都从那取。要让壳**完全脱离 DSH**，最省的做法不是改前端，而是
// 在壳里起一个只服务本机的小服务，把同一套路径补齐：
//
//   GET  /dsh-pet/standalone/            独立预览页（standalone/index.html）
//   GET  /dsh-pet/pet.js                 前端本体（壳的"发现宿主"也探这一条，所以必须 200）
//   GET  /dsh-pet/config                 配置（从 pet.js 里抠出来的默认值，保证与前端一致）
//   GET  /dsh-pet/model/**  vendor/**    模型与运行时（静态文件）
//   GET  /dsh-pet/media[-smtc.js]        媒体会话：列会话 / 读当前 / 遥控（复用 lib/media-bridge.mjs）
//   GET  /dsh-pet/state | /events        最小实现：告诉她"在这儿、空闲"，SSE 立刻挂着不报错
//
// 没有实现的（前端本来就对失败有兜底，会安静降级）：
//   /dsh-pet/hud（钱包）、/dsh-pet/say、/dsh-pet/control、/dsh-pet/cancel —— 这些是"接进会话"的能力，
//   只有 DSH 宿主才有。独立模式下没有它们，她照样渲染、换表情、用菜单、跟着系统音乐动。
//
// 安全：只绑 127.0.0.1；媒体路由沿用 lib/media-bridge.mjs 的命令白名单与过滤器校验；
// 静态文件做目录穿越防护。没有任何出网请求。
// ============================================================================
'use strict'
// ⚠️ 生成物：由 desktop/standalone/server.mjs 机械转换而来（理由见那边文件头注释）。
// 要改逻辑请改 .mjs，然后重新生成：node D:\Bigfish\_staging\make-shell-cjs-server.mjs
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { createMediaBridge, mediaReason, MEDIA_APP_RE } = require('./media-bridge.cjs')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.css': 'text/css; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

/** 找出仓库根目录（assets/ 所在处）：开发时就是包目录；打包后由 extraResources 带过来 */
function resolveRepoRoot(extra) {
  const cands = [
    process.env.DSHW_PET_ROOT,
    extra,
    path.resolve(process.cwd()),
    path.resolve(__dirname, '..', '..'),
    process.resourcesPath ? path.join(process.resourcesPath, 'dsh-whale-song') : '',
    process.resourcesPath || '',
  ].filter(Boolean)
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, 'assets', 'pet.js'))) return c } catch (err) {}
  }
  return ''
}

/** 从 pet.js 里抠出默认配置（保持与前端一致；抠不到就用一份最小兜底） */
function readDefaultConfig(repoRoot) {
  const fallback = { enabled: true, height: 180, corner: 'br' }
  try {
    const src = fs.readFileSync(path.join(repoRoot, 'assets', 'pet.js'), 'utf8')
    const i = src.indexOf('DEFAULT_CONFIG = {')
    if (i < 0) return fallback
    let depth = 0
    let end = -1
    for (let k = src.indexOf('{', i); k < src.length; k++) {
      if (src[k] === '{') depth++
      else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
    }
    if (end < 0) return fallback
    const literal = src.slice(src.indexOf('{', i), end + 1)
    // 只允许对象字面量里的简单值：用 Function 求值一次（这是**我们自己仓库里的文件**，不是外部输入）
    // eslint-disable-next-line no-new-func
    const obj = new Function('return (' + literal + ')')()
    return obj && typeof obj === 'object' ? obj : fallback
  } catch (err) {
    return fallback
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { try { req.destroy() } catch (err) {} resolve('') ; return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/**
 * 起迷你服务。
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] 仓库根（含 assets/）
 * @param {number} [opts.port] 0 = 让系统挑一个空闲端口
 * @returns {Promise<{port:number, url:string, close:Function, media:object}>}
 */
function startPetServer(opts) {
  const o = opts || {}
  const repoRoot = o.repoRoot || resolveRepoRoot(o.extra)
  if (!repoRoot) throw new Error('找不到 assets/ 所在的仓库根目录（用 DSHW_PET_ROOT 指定）')
  const assetsDir = path.join(repoRoot, 'assets')
  const standaloneDir = path.join(repoRoot, 'standalone')
  const shellDir = path.join(repoRoot, 'desktop', 'standalone')
  const config = readDefaultConfig(repoRoot)
  const media = createMediaBridge()
  /**
   * 窗口成型的回调（由壳注入）。页面 POST /dsh-pet/shape 时调用。
   * 纯 Node 测试时不给 —— 那时接口返回 { ok:false, error:'unsupported' }，不影响其它功能。
   */
  const shape = typeof o.onShape === 'function' ? o.onShape : async () => ({ ok: false, error: 'unsupported' })

  function serveFile(res, abs, cache) {
    let buf = null
    try { buf = fs.readFileSync(abs) } catch (err) {}
    if (!buf) { json(res, 404, { ok: false, error: 'not found' }); return }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': String(buf.length),
      'Cache-Control': cache || 'no-store',
    })
    res.end(buf)
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const p = url.pathname
    try {
      // —— 媒体会话（复用宿主那份实现：白名单、过滤器校验、缓存都在里面）——
      if (p === '/dsh-pet/media') {
        const app = url.searchParams.get('app') || ''
        if (app && !MEDIA_APP_RE.test(app)) { json(res, 200, { ok: false, error: 'bad-app', reason: mediaReason('bad-app') }); return }
        if (req.method === 'GET') {
          if (url.searchParams.get('list') === '1') {
            const r = await media.listSessions()
            json(res, 200, r.ok ? { ok: true, sessions: r.sessions || [], reason: '' } : { ok: false, sessions: [], error: r.error, reason: mediaReason(r.error) })
            return
          }
          const r = await media.readNow(app)
          json(res, 200, r.ok ? { ok: true, nowPlaying: r.nowPlaying || null, reason: '' } : { ok: false, nowPlaying: null, error: r.error, reason: mediaReason(r.error) })
          return
        }
        if (req.method === 'POST') {
          let body = {}
          try { body = JSON.parse((await readBody(req)) || '{}') } catch (err) {}
          const r = await media.control(body.cmd, body.app == null ? '' : String(body.app))
          if (!r.ok && r.error === 'bad-cmd') { json(res, 400, { ok: false, error: 'bad-cmd', reason: r.reason }); return }
          json(res, 200, r.ok
            ? { ok: true, did: r.did, requested: r.requested, appId: r.appId || '', reason: '' }
            : { ok: false, error: r.error, reason: r.reason || mediaReason(r.error) })
          return
        }
        res.writeHead(405, { 'Content-Type': MIME['.json'] }).end(JSON.stringify({ ok: false, error: 'method-not-allowed' }))
        return
      }

      // —— 前端脚本：都从 assets/ 取（pet.js 的"发现宿主"探的就是这一条，必须 200）——
      const scriptMap = {
        '/dsh-pet/pet.js': path.join(assetsDir, 'pet.js'),
        '/dsh-pet/media-smtc.js': path.join(assetsDir, 'media-smtc.js'),
        '/dsh-pet/media-local.js': path.join(assetsDir, 'media-local.js'),
        '/dsh-pet/media-bridge.js': path.join(assetsDir, 'media-bridge.js'),
      }
      if (scriptMap[p]) { serveFile(res, scriptMap[p]); return }

      // —— 配置：给她一份和前端默认值一致的配置（里头的 enabled 必须为真）——
      if (p === '/dsh-pet/config') { json(res, 200, config); return }

      // —— 状态：独立模式下就是"她在这儿、空闲"。前端只读 status/turn/step 这几个字段 ——
      if (p === '/dsh-pet/state') {
        json(res, 200, {
          ok: true, version: 'standalone', sessionId: '', status: 'idle', turn: 0, step: 0,
          clients: 0, hasSessionController: false, lastEventAt: 0, desktop: true, standalone: true,
        })
        return
      }

      // —— SSE：挂住但**永不发事件**（没有 agent 就没有事件可推）。前端拿到 200 就不报错 ——
      if (p === '/dsh-pet/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        })
        try { res.write(': standalone\n\n') } catch (err) {}
        const ping = setInterval(() => { try { res.write(': ping\n\n') } catch (err) {} }, 25000)
        const done = () => { clearInterval(ping); try { res.end() } catch (err) {} }
        req.on('close', done)
        req.on('error', done)
        return
      }

      // —— 静态：模型与运行时 ——
      if (p.startsWith('/dsh-pet/model/') || p.startsWith('/dsh-pet/vendor/')) {
        const rel = p.replace(/^\/dsh-pet\/(model|vendor)\//, '$1/')
        const abs = path.resolve(assetsDir, rel)
        if (abs !== assetsDir && !abs.startsWith(assetsDir + path.sep)) { res.writeHead(403).end(); return }
        serveFile(res, abs, 'no-cache')
        return
      }

      // —— 窗口成型（Win32 区域）：页面把命中掩码 POST 上来，壳据此把窗口裁成她的轮廓 ——
      // 于是"鼠标在不在她身上"由**窗口几何**决定，不再靠 90ms 轮询猜（那套已删除）。
      if (p === '/dsh-pet/shape') {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        let body = null
        try { body = JSON.parse((await readBody(req, 2 * 1024 * 1024)) || 'null') } catch (err) {}
        if (!body) { json(res, 200, { ok: false, error: 'bad-body' }); return }
        try {
          const r = await shape(body)
          json(res, 200, r || { ok: true })
        } catch (err) {
          json(res, 200, { ok: false, error: String((err && err.message) || err) })
        }
        return
      }

      // —— 独立预览页：/dsh-pet/standalone 与 /dsh-pet/standalone/ 都给同一个页面 ——
      if (p === '/dsh-pet/standalone' || p === '/dsh-pet/standalone/' || p === '/dsh-pet') {
        serveFile(res, path.join(standaloneDir, 'index.html'))
        return
      }
      // —— 壳专用页面：她本体（全透明，无说明表）。壳把它当主页面加载 ——
      if (p === '/dsh-pet/app' || p === '/dsh-pet/app/') {
        serveFile(res, path.join(shellDir, 'ui', 'index.html'))
        return
      }
      if (p.startsWith('/dsh-pet/standalone/')) {
        const rel = p.replace(/^\/dsh-pet\/standalone\//, '')
        const abs = path.resolve(standaloneDir, rel)
        if (abs !== standaloneDir && !abs.startsWith(standaloneDir + path.sep)) { res.writeHead(403).end(); return }
        serveFile(res, abs)
        return
      }

      json(res, 404, { ok: false, error: 'not-found', path: p, standalone: true })
    } catch (err) {
      try { json(res, 500, { ok: false, error: String((err && err.message) || err) }) } catch (e) {}
    }
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(o.port || 0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        port: port,
        url: 'http://127.0.0.1:' + port + '/dsh-pet',
        petBase: 'http://127.0.0.1:' + port,
        repoRoot: repoRoot,
        media: media,
        close: () => { try { server.close() } catch (err) {} },
      })
    })
  })
}

module.exports = { startPetServer, resolveRepoRoot }
