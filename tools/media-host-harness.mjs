// ============================================================================
// media-host-harness.mjs —— 只起一个"够用"的宿主，用来看统一的媒体页签长什么样
// ----------------------------------------------------------------------------
// 为什么需要它：宿主插件只在 DSH 启动时加载，改完 lib/ 要重启 DSH 才生效 —— 而重启会掐掉
// 主人正在用的会话。这个 harness 用假 ctx 挂载**同一个 lib/index.js**（真路由、真 SMTC），
// 只多打一张桌面版通行证 cookie（信任栅栏要求），于是可以在一个空端口上真看界面。
//
// 它**不是**产品的一部分，只是排障/取证用：
//   node tools/media-host-harness.mjs [--port 41999] [--open]
// 打开 http://127.0.0.1:41999/dsh-pet  就能看到桌宠（含音乐页签）。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const argv = process.argv.slice(2)
const portArg = argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 41999
const OPEN = argv.includes('--open')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DESKTOP_FILE = path.join(DSH_HOME, 'dsh-live2d-pet-desktop.json')

// 通行证：优先用 DSH 已经写好的（说明它是真身），没有就自己造一个给栅栏用
let token = ''
try {
  const saved = JSON.parse(fs.readFileSync(DESKTOP_FILE, 'utf8'))
  token = String(saved.token || saved.key || '')
} catch (err) {}
if (!token) {
  token = Buffer.from(String(Date.now()) + Math.random()).toString('hex').slice(0, 32)
  try {
    fs.mkdirSync(DSH_HOME, { recursive: true })
    fs.writeFileSync(DESKTOP_FILE, JSON.stringify({ token, port: PORT }, null, 2), 'utf8')
  } catch (err) {}
  console.log('[harness] 自己造了通行证写进 ' + DESKTOP_FILE)
}

const routes = []
const fakeCtx = {
  webServer: {
    port: PORT,
    register(r) { routes.push(r); return () => {} },
    // 桌面壳那条注入路子：harness 直接在 /dsh-pet 页面里手写 <script>，用不上
    tapIndex(fn) { fakeCtx.__tapIndex = fn; return () => {} },
  },
  // 栅栏：harness 里只认"带对了通行证"，别的请求一律 401 —— 与真宿主同一种语义
  connection: {
    requestRejection(req) {
      const cookie = String(req.headers.cookie || '')
      if (cookie.split(/;\s*/).some((c) => c === 'dsh_pet_desk=' + token)) return null
      if (String(req.url || '').indexOf('k=' + token) >= 0) return null
      return 401
    },
  },
  effect(fn) { return fn() },
  get(name) { return name === 'connection' ? this.connection : undefined },
  on() {},
  logger: console,
}

const plugin = (await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)).default
plugin.apply(fakeCtx)

// /dsh-pet 的极简页面：和宿主注入的标签一致（pet.js + media-smtc.js + media-bridge.js）
// 通行证直接写进页面里，让页面自己下成 cookie —— 这样用无头浏览器打开就能拿到授权，
// 不用把 cookie 塞进浏览器 profile。注意：harness 只绑 127.0.0.1、只监听自己那个端口，
// 而且 cookie 的 Path 限定在 /dsh-pet，所以这张票出不了这个端口。
const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>鲸歌 · 媒体页签 harness</title>
<style>html,body{margin:0;height:100%;background:#0f1720;color:#cfe3f5;font:14px/1.6 system-ui,sans-serif}
.note{padding:10px 14px;background:#16222e;border-bottom:1px solid #24333f}
.note b{color:#7fd1ff}</style></head><body>
<div class="note">harness 页面（不是产品的一部分）：点右下角的鲸鱼娘 → <b>⋯ 菜单</b> → <b>音乐</b> 页签。
先随便开一个播放器放首歌，这里几秒内就会列出它；本地音乐那栏要放音频文件才会出现歌单。</div>
<script>try{document.cookie='dsh_pet_desk=${token}; Path=/dsh-pet'}catch(e){}</script>
<script>location.reload&&setTimeout(function(){if(document.cookie.indexOf('dsh_pet_desk=')<0)location.reload()},50)</script>
<script defer src="/dsh-pet/pet.js"></script>
<script defer src="/dsh-pet/media-smtc.js"></script>
<script defer src="/dsh-pet/media-local.js"></script>
<script defer src="/dsh-pet/media-bridge.js"></script>
</body></html>`

const server = http.createServer((req, res) => {
  const pathname = String(req.url || '/').split('?')[0]
  if (pathname === '/dsh-pet' || pathname === '/dsh-pet/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'dsh_pet_desk=' + token + '; Path=/' })
    res.end(PAGE)
    return
  }
  for (const r of routes) {
    const hit = r.kind === 'exact' ? pathname === r.path : pathname.startsWith(r.path)
    if (hit) { r.handler(req, res); return }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found: ' + pathname)
})

server.listen(PORT, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + PORT + '/dsh-pet'
  console.log('[harness] 已挂载 ' + routes.length + ' 条路由 · ' + url)
  console.log('[harness] 通行证：' + token.slice(0, 8) + '…（来自 ' + DESKTOP_FILE + '）')
  if (OPEN) {
    try {
      spawnSync('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' })
    } catch (err) {}
  }
})
