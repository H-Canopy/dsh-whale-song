// ============================================================================
// test-standalone.mjs —— 验"不连 DSH 她也站得起来"（无头浏览器，真渲染）
// ----------------------------------------------------------------------------
// 做法：起 tools/serve-standalone.mjs（纯静态，**没有**任何 /dsh-pet/* 接口），
// 用无头 Chromium 打开 standalone/index.html，等模型加载，然后断言：
//   · 页面把 vendor 三件套与模型清单都从静态目录取来了（说明 BASE 指向正确）
//   · window.DSHPet 挂上了（说明 pet.js 跑完没崩）
//   · 模型真的加载：状态里有可用表情/动作、画布有内容
//   · 宿主接口（/events 等）确实拿不到 —— 前提是**她仍然活着**（这是独立模式的全部意义）
//
// 跑：node tools/test-standalone.mjs
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const PORT = 41998
const CDP_PORT = 9801
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
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].filter(Boolean)
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch (err) {} }
  return ''
}

const staticServer = spawn(process.execPath, [path.join(HERE, 'serve-standalone.mjs'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
staticServer.stdout.on('data', (d) => { serverLog += d })
staticServer.stderr.on('data', (d) => { serverLog += d })

const CHROME = findBrowser()
if (!CHROME) {
  console.log('找不到 Chromium 浏览器（Chrome/Edge）：设 CHROME_PATH 再跑')
  try { staticServer.kill() } catch (err) {}
  process.exit(2)
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-standalone-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--no-sandbox', '--disable-gpu-sandbox', '--no-zygote', '--disable-dev-shm-usage',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1200,820', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] })

function cleanup(code) {
  try { chrome.kill('SIGKILL') } catch (err) {}
  try { staticServer.kill('SIGKILL') } catch (err) {}
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch (err) {}
  process.exit(code)
}

try {
  // 等静态服务
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/standalone/'); up = r.ok } catch (err) {}
    if (!up) await sleep(150)
  }
  ok(up, '静态服务起来了（且不提供任何 /dsh-pet 接口）', serverLog.slice(0, 200))

  let ver = null
  for (let i = 0; i < 80 && !ver; i++) {
    try { ver = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json() } catch (err) {}
    if (!ver) await sleep(150)
  }
  if (!ver) throw new Error('Chromium 没起来')
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let id = 0
  const pend = new Map()
  const httpLog = []
  ws.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
    let m
    try { m = JSON.parse(raw) } catch (err) { return }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
    if (m.method === 'Network.responseReceived') {
      const r = m.params && m.params.response
      if (r) httpLog.push({ url: String(r.url), status: r.status })
    }
  })
  const send = (method, params, sid, to = 30000) => new Promise((resolve, reject) => {
    const i = ++id
    const t = setTimeout(() => { pend.delete(i); reject(new Error('CDP 超时 ' + method)) }, to)
    pend.set(i, (m) => { clearTimeout(t); m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result) })
    const msg = { id: i, method, params: params || {} }
    if (sid) msg.sessionId = sid
    ws.send(JSON.stringify(msg))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Network.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false }, sessionId, 5000).catch(() => {})
  const ev = async (expr, to) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId, to || 30000)
    if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text))
    return r.result && r.result.value
  }

  console.log('\n--- 打开独立页面（没有任何后端接口）---')
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/standalone/' }, sessionId, 15000).catch(() => {})
  let ready = false
  for (let i = 0; i < 90; i++) {
    try {
      const st = await ev('({ pet: !!window.DSHPet, err: String(window.__DSHPetError || "" ), cfg: typeof window.__DSH_PET_BASE__ })')
      if (st && st.pet) { ready = true; console.log('  页面就绪：' + JSON.stringify(st)); break }
      if (st && st.err) { console.log('  页面报错：' + st.err.slice(0, 300)); break }
    } catch (err) {}
    await sleep(250)
  }
  ok(ready, '不连 DSH 时 pet.js 也跑完了（window.DSHPet 挂上）', '')

  // 运行时与模型是否真的放对了位置 —— **直接对静态资源发请求核对**，不看网络日志。
  // （日志采集对 XHR/异步时序不可靠：模型加载晚于 Network.enable，实测漏记过。
  //   直接请求是确定的证据，而且只花几毫秒。）
  const assetBase = 'http://127.0.0.1:' + PORT + '/assets/'
  const mustExist = [
    'vendor/live2dcubismcore.min.js',
    'vendor/pixi.min.js',
    'vendor/cubism4.min.js',
    'model/manifest.json',
    'model/c_0120.model3.json',
    'model/c_0120.moc3',
    'model/c_0120.2048/texture_00.png',
    'model/expressions/爱心眼.exp3.json',
  ]
  for (const rel of mustExist) {
    let status = 0
    try { const r = await fetch(assetBase + encodeURI(rel)); status = r.status } catch (err) { status = -1 }
    if (status !== 200) ok(false, '静态资源在位：' + rel, 'status=' + status)
  }
  ok(mustExist.length > 0, '静态资源逐个核对完了（' + mustExist.length + ' 个：运行时 / 清单 / 模型本体 / 贴图 / 表情）', '')
  const missing = httpLog.filter((r) => /\/assets\//.test(r.url) && r.status >= 400)
  ok(missing.length === 0, '页面自己请求过的静态资源也没有 404/500', JSON.stringify(missing.slice(0, 3)))

  // 宿主接口确实拿不到 —— 直接问页面（SSE 连接失败不会有 responseReceived 事件，
  // 所以不能只看上面那份 httpLog）
  const backend = await ev(`(async () => {
    const out = {}
    for (const p of ['/dsh-pet/state', '/dsh-pet/config', '/dsh-pet/media?list=1']) {
      try { const r = await fetch(p); out[p] = r.status } catch (e) { out[p] = 'ERR ' + (e && e.message) }
    }
    out.standaloneFlag = !!(window.__DSH_PET_BOOT__ && window.__DSH_PET_BOOT__.standalone)
    return out
  })()`)
  console.log('  后端探测：' + JSON.stringify(backend))
  ok(backend && backend.standaloneFlag === true, '页面带着 standalone 标记（前端据此知道自己在单机模式）', JSON.stringify(backend))
  ok(backend && /ERR|4\d\d|5\d\d/.test(String(backend['/dsh-pet/state'])), '宿主接口确实拿不到（' + backend['/dsh-pet/state'] + '）—— 独立模式的前提成立', JSON.stringify(backend))

  // 关键：这种情况下她还活着，并且模型真的在渲染。
  // ⚠️ 模型是**异步**加载的：加载完成前会有一个 8x8 的空画布（PIXI 初始化时的大小），
  // 早采样会误判成"没画出来"。所以这里轮询等她真的画出来（宽度 > 100 且非空像素 > 0）。
  const sampleCanvas = () => ev(`(() => {
    const cs = Array.from(document.querySelectorAll('canvas'))
    const c = cs.map((x) => ({ x: x, w: x.width, h: x.height })).sort((a, b) => b.w * b.h - a.w * a.h)[0]
    if (!c) return { has: false, canvases: cs.length }
    let solid = 0
    try {
      const g = document.createElement('canvas')
      g.width = 120; g.height = 120
      const ctx2 = g.getContext('2d')
      ctx2.drawImage(c.x, 0, 0, 120, 120)
      const d = ctx2.getImageData(0, 0, 120, 120).data
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) solid++
    } catch (e) { return { has: true, err: String(e && e.message), size: c.w + 'x' + c.h } }
    return { has: true, solid: solid, canvases: cs.length, size: c.w + 'x' + c.h }
  })()`)
  let drawn = null
  for (let i = 0; i < 60; i++) {
    drawn = await sampleCanvas()
    if (drawn && drawn.has && drawn.solid > 50 && parseInt(String(drawn.size).split('x')[0], 10) > 100) break
    await sleep(300)
  }
  console.log('  画布采样：' + JSON.stringify(drawn))
  ok(!!drawn && drawn.has === true && drawn.solid > 50, '画布上真的画出了她（' + (drawn && drawn.solid) + ' 个非空像素，画布 ' + (drawn && drawn.size) + '）', JSON.stringify(drawn))

  const alive = await ev(`(() => {
    const m = window.DSHPet.menu()
    const a = window.DSHPet.actions ? window.DSHPet.actions() : null
    return { open: !!(m && m.open), status: m && m.status, actions: a ? (a.length || Object.keys(a).length) : null }
  })()`)
  console.log('  她的现场：' + JSON.stringify(alive))
  ok(!!alive && typeof alive.status === 'string' && alive.status.length > 0, '状态行正常："' + (alive && alive.status) + '"', '')
  ok(!!alive && alive.actions >= 8, '一次性动作有 ' + (alive && alive.actions) + ' 个可用（模型清单读到了）', JSON.stringify(alive))

  const drawn2 = await sampleCanvas()

  // 菜单能用（独立模式下"能做的事"里最有价值的一项）：真点开 ⋯ 再数按钮
  const menuOpen = await ev(`(() => {
    const btn = document.querySelector('.dshp-dock button:nth-child(2)')
    if (!btn) return { found: false }
    btn.click()
    return { found: true }
  })()`)
  await sleep(600)
  const menu = await ev('window.DSHPet.menu()')
  console.log('  菜单：' + JSON.stringify({ open: menu && menu.open, focused: menu && menu.focused, chips: ((menu && menu.chips) || []).length }))
  ok(!!menuOpen && menuOpen.found === true, '找到工具栏 ⋯ 按钮', JSON.stringify(menuOpen))
  ok(!!menu && menu.open === true, '菜单真的打开了（单机模式下也能用）', JSON.stringify(menu && menu.open))
  ok(!!menu && Array.isArray(menu.chips) && menu.chips.length > 5, '菜单里有 ' + ((menu && menu.chips) || []).length + ' 个按钮（表情页）', JSON.stringify(((menu && menu.chips) || []).map((c) => c.label).slice(0, 6)))

  // 静态页上的"搭配 DSH 才完整"说明必须在（这是产品要求的一部分）
  const copy = await ev('document.body.innerText')
  ok(/搭配|完整版/.test(String(copy)) && /dsh plugin/.test(String(copy)),
    '页面明说了"搭配 DSH 才是完整版"，并给出安装命令', String(copy).slice(0, 120).replace(/\n/g, ' '))

  // 截图留证
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId, 20000)
  const out = path.join(ROOT, 'docs', 'probe')
  fs.mkdirSync(out, { recursive: true })
  const file = path.join(out, 'standalone.png')
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log('  截图：' + file)

  console.log('\n结果：pass ' + pass + ' / fail ' + fail)
  cleanup(fail ? 1 : 0)
} catch (err) {
  console.log('\n失败：' + ((err && err.stack) || err))
  cleanup(3)
}
