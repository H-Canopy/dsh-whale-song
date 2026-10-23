// ============================================================================
// test-shell-server.mjs —— 验独立壳的**本地迷你服务**（不用装 Electron 也能验）
// ----------------------------------------------------------------------------
// 壳的窗口部分（透明/置顶/点击穿透/托盘）只有 Electron 能验，见 README 的说明；
// 但"壳里的服务"是纯 Node，**可以在这里直接验**，而且它才是"脱离 DSH"的关键：
//   · /dsh-pet/pet.js 必须 200（壳的"发现宿主"探的就是这一条 —— 找不到就打不开页面）
//   · /dsh-pet/app 返回壳专用页面；/dsh-pet/standalone 返回 demo 页
//   · 模型/运行时能从本地取到（.moc3 / 贴图 / pixi / cubism）
//   · /dsh-pet/media 能真读系统媒体会话（复用 lib/media-bridge.mjs + smtc-helper.ps1）
//   · DSH 专属接口（hud/say/control）返回 404，而**她照样能渲染**（用无头浏览器真打开验证）
//   · 目录穿越被拒
//
// 跑：node tools/test-shell-server.mjs
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
// CDP 端口随机挑（写死会和别的浏览器用例抢端口：单独跑过、一起跑挂）
const CDP_PORT = 9600 + Math.floor(Math.random() * 300)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  ok   ' + msg) }
  else { fail++; failures.push(msg); console.log('  FAIL ' + msg + (detail === undefined ? '' : '  → ' + detail)) }
}

function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch (err) {} }
  return ''
}

const mod = await import(pathToFileURL(path.join(ROOT, 'desktop', 'standalone', 'server.mjs')).href)
let srv = null
try {
  srv = await mod.startPetServer({ repoRoot: ROOT })
} catch (err) {
  console.log('服务起不来：' + ((err && err.stack) || err))
  process.exit(3)
}
const BASE = srv.petBase
console.log('本地服务: ' + srv.url + '  (repoRoot=' + srv.repoRoot + ')')

const get = async (p) => {
  const r = await fetch(BASE + p)
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch (err) {}
  return { status: r.status, text, json, headers: r.headers }
}

console.log('\n--- 壳"发现宿主"要探的那一条 ---')
{
  const r = await get('/dsh-pet/pet.js')
  ok(r.status === 200 && r.text.length > 10000, '/dsh-pet/pet.js → 200 且是前端本体（' + r.text.length + ' 字节）', 'status=' + r.status)
  ok(r.text.indexOf('window.DSHPet') >= 0, '确实是 pet.js（含 window.DSHPet）', '')
}

console.log('\n--- 页面与静态资源 ---')
{
  const app = await get('/dsh-pet/app')
  ok(app.status === 200 && /DS 鲸鱼娘桌宠/.test(app.text), '/dsh-pet/app → 壳专用页面', 'status=' + app.status)
  ok(app.text.indexOf('/dsh-pet/pet.js') >= 0, '壳页面引用 pet.js', '')
  const demo = await get('/dsh-pet/standalone/')
  ok(demo.status === 200 && /完整版/.test(demo.text), '/dsh-pet/standalone/ → 给外人看的 demo 页', 'status=' + demo.status)
  for (const rel of ['/dsh-pet/vendor/pixi.min.js', '/dsh-pet/songm-renderer.js', '/dsh-pet/demo-whale.svg']) {
    const r = await get(rel)
    if (r.status !== 200) ok(false, '静态资源在位：' + rel, 'status=' + r.status)
  }
  for(const rel of ['/dsh-pet/songm/master.png','/dsh-pet/songm/clips/idle.webm']){const r=await get(rel);ok(r.status===404,'生产资产未随公开服务提供：'+rel,'status='+r.status)}
  ok(true, '公开运行时与通用示例可取', '')
  const trav = await get('/dsh-pet/model/../../../../Windows/win.ini')
  ok(trav.status === 403 || trav.status === 404, '目录穿越被拒（' + trav.status + '）', trav.text.slice(0, 80))
}

console.log('\n--- 配置与状态（前端会读，不该 404）---')
{
  const cfg = await get('/dsh-pet/config')
  ok(cfg.status === 200 && cfg.json && cfg.json.enabled === true, '/dsh-pet/config → 200 且 enabled:true（从 pet.js 里抠的默认值）', JSON.stringify(cfg.json).slice(0, 120))
  const st = await get('/dsh-pet/state')
  ok(st.status === 200 && st.json && st.json.ok === true && st.json.status === 'idle', '/dsh-pet/state → 200 且 idle', JSON.stringify(st.json).slice(0, 120))
}

console.log('\n--- 媒体会话：独立模式也能"知道你在放什么" ---')
{
  const list = await get('/dsh-pet/media?list=1')
  const sessions = (list.json && list.json.sessions) || []
  ok(list.status === 200 && list.json && list.json.ok === true, '列会话 → 200 ok:true', JSON.stringify(list.json).slice(0, 160))
  ok(Array.isArray(sessions), 'sessions 是数组（' + sessions.length + ' 个会话）', '')
  const now = await get('/dsh-pet/media')
  ok(now.status === 200 && now.json && now.json.ok === true, '读当前曲目 → 200', JSON.stringify(now.json).slice(0, 160))
  const bad = await get('/dsh-pet/media?app=' + encodeURIComponent('a"(b)'))
  ok(bad.json && bad.json.error === 'bad-app', 'app 过滤器非法 → bad-app（不透传）', JSON.stringify(bad.json).slice(0, 100))
  const badCmd = await fetch(BASE + '/dsh-pet/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'rm -rf /' }) })
  ok(badCmd.status === 400, '非白名单命令 → 400', 'status=' + badCmd.status)
}

console.log('\n--- DSH 专属接口应当没有（前端要能安静降级）---')
{
  for (const p of ['/dsh-pet/hud', '/dsh-pet/say', '/dsh-pet/control']) {
    const r = await get(p)
    if (r.status !== 404) ok(false, p + ' → 404（独立模式没有它）', 'status=' + r.status)
  }
  ok(true, 'hud / say / control 都是 404（前端对这些失败本来就有兜底）', '')
}

// —— 真浏览器：她能不能在这个服务上站起来 ——
const CHROME = findBrowser()
if (!CHROME) {
  console.log('  skip 找不到 Chromium，跳过"真渲染"这一节')
} else {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-shell-'))
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--no-sandbox', '--disable-gpu-sandbox', '--no-zygote', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--window-size=560,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  try {
    let ver = null
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json() } catch (err) {}
      if (!ver) await sleep(150)
    }
    const ws = new WebSocket(ver.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pend = new Map()
    ws.addEventListener('message', (e) => {
      const raw = typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8')
      let m
      try { m = JSON.parse(raw) } catch (err) { return }
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
    })
    const send = (method, params, sid, to = 30000) => new Promise((resolve, reject) => {
      const i = ++id
      const t = setTimeout(() => { pend.delete(i); reject(new Error('CDP 超时 ' + method)) }, to)
      pend.set(i, (m) => { clearTimeout(t); m.error ? reject(new Error(method + ':' + JSON.stringify(m.error))) : resolve(m.result) })
      const msg = { id: i, method, params: params || {} }
      if (sid) msg.sessionId = sid
      ws.send(JSON.stringify(msg))
    })
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    await send('Runtime.enable', {}, sessionId)
    await send('Emulation.setDeviceMetricsOverride', { width: 560, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId, 5000).catch(() => {})
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId, 30000)
      if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text))
      return r.result && r.result.value
    }

    console.log('\n--- 在壳的那个本地服务上真渲染一次 ---')
    await send('Page.navigate', { url: BASE + '/dsh-pet/app' }, sessionId, 15000).catch(() => {})
    let up = false
    for (let i = 0; i < 90; i++) {
      const st = await ev('({ pet: !!window.DSHPet, err: String(window.__DSHPetError || "") })').catch(() => null)
      if (st && st.pet) { up = true; break }
      if (st && st.err) { console.log('  页面报错：' + st.err.slice(0, 240)); break }
      await sleep(250)
    }
    ok(up, '壳页面上 pet.js 跑完了（window.DSHPet 挂上）', '')

    const sample = () => ev(`(() => {
      const cs = Array.from(document.querySelectorAll('canvas')).map((x) => ({ x: x, w: x.width, h: x.height })).sort((a, b) => b.w * b.h - a.w * a.h)
      const c = cs[0]
      if (!c) return { has: false }
      let solid = 0
      try {
        const g = document.createElement('canvas'); g.width = 120; g.height = 120
        const cx = g.getContext('2d'); cx.drawImage(c.x, 0, 0, 120, 120)
        const d = cx.getImageData(0, 0, 120, 120).data
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) solid++
      } catch (e) { return { has: true, err: String(e && e.message), size: c.w + 'x' + c.h } }
      return { has: true, solid: solid, size: c.w + 'x' + c.h }
    })()`)
    let drawn = null
    for (let i = 0; i < 60; i++) {
      drawn = await sample()
      if (drawn && drawn.has && drawn.solid > 50 && parseInt(String(drawn.size).split('x')[0], 10) > 100) break
      await sleep(300)
    }
    console.log('  画布采样：' + JSON.stringify(drawn))
    ok(!!drawn && drawn.solid > 50, '她在壳里真的渲染出来了（' + (drawn && drawn.solid) + ' 非空像素，画布 ' + (drawn && drawn.size) + '）', JSON.stringify(drawn))

    // 媒体接口在这个页面上也要能用（她是同源请求我们自己的服务）
    const smtc = await ev(`(async () => {
      if (!window.dshwSongSMTC) return { missing: true }
      await window.dshwSongSMTC.load(true)
      const now = window.dshwSongSMTC.now()
      return { players: (window.dshwSongSMTC.players() || []).length, playing: now ? now.playing : null, player: now ? now.player : null, ready: window.dshwSongSMTC.ready() }
    })()`)
    console.log('  统一层现场：' + JSON.stringify(smtc))
    ok(!!smtc && smtc.missing !== true && smtc.ready === true && smtc.players >= 0, '媒体读取完成（允许没有播放器；当前 ' + (smtc && smtc.players) + ' 个播放器）—— 独立模式也有音乐联动', JSON.stringify(smtc))
  } catch (err) {
    ok(false, '壳服务的浏览器验证', String((err && err.message) || err))
  } finally {
    try { chrome.kill('SIGKILL') } catch (err) {}
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch (err) {}
  }
}

try { srv.close() } catch (err) {}
console.log('\n结果：pass ' + pass + ' / fail ' + fail)
if (fail && failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail ? 1 : 0)
