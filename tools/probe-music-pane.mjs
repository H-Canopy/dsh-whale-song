// ============================================================================
// probe-music-pane.mjs —— 用无头浏览器**真点一次**「音乐」页签，并留下截图当证据
// ----------------------------------------------------------------------------
// 为什么要有它：宿主插件只在 DSH 启动时加载，改完 lib/ 要重启 DSH —— 而重启会掐掉主人
// 正在用的会话。这个探针自己起一个 harness 宿主（tools/media-host-harness.mjs，真路由 + 真 SMTC）
// 和一个无头 Chromium，用 CDP 发**真鼠标事件**点开菜单 → 音乐页签，然后读回页面里的真实
// 状态（DSHPet.menu()）并截图。
//
// 跑：
//   node tools/probe-music-pane.mjs                 # 起 harness（默认 41999）
//   node tools/probe-music-pane.mjs --url <地址>    # 用已经在跑的宿主/DSH 页面
// 产物：docs/probe/music-pane.png（截图）+ 控制台里的断言结果
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const OUT_DIR = path.join(ROOT, 'docs', 'probe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    '/usr/bin/chromium',
  ].filter(Boolean)
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch (err) {} }
  return ''
}

let pass = 0
let fail = 0
const ok = (c, m, d) => {
  if (c) { pass++; console.log('  ok   ' + m) }
  else { fail++; console.log('  FAIL ' + m + (d === undefined ? '' : '  → ' + d)) }
}

const urlArg = (() => { const i = process.argv.indexOf('--url'); return i >= 0 ? process.argv[i + 1] : '' })()
// --live-control：会**短暂改变**一个真播放器的播放状态（读完立刻复原），需要你显式加这个参数。
// 为什么不默认开：主人明确要求"测试不要乱放歌"。浏览器会话（Edge/Chrome）不接受外部控制，
// 所以这条只挑非浏览器的会话，并且必须复原到操作前的状态与曲目。
const LIVE_CONTROL = process.argv.includes('--live-control')
const HARNESS_PORT = 41999
let harness = null
let target = urlArg

if (!target) {
  harness = spawn(process.execPath, [path.join(HERE, 'media-host-harness.mjs'), '--port', String(HARNESS_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
  harness.stdout.on('data', (d) => process.stdout.write('[harness] ' + d))
  harness.stderr.on('data', (d) => process.stderr.write('[harness:err] ' + d))
  target = 'http://127.0.0.1:' + HARNESS_PORT + '/dsh-pet'
  // 等它起来
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:' + HARNESS_PORT + '/dsh-pet'); if (r.ok) break } catch (err) {}
    await sleep(150)
  }
}

const CHROME = findBrowser()
if (!CHROME) {
  console.log('找不到 Chromium 浏览器（Chrome/Edge）：设 CHROME_PATH 环境变量再跑')
  process.exit(2)
}

const CDP_PORT = 9700 + Math.floor(Math.random() * 200)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-musicprobe-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--no-sandbox', '--disable-gpu-sandbox', '--no-zygote', '--disable-dev-shm-usage',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1200,820', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] })

function cleanup(code) {
  try { chrome.kill('SIGKILL') } catch (err) {}
  try { if (harness) harness.kill('SIGKILL') } catch (err) {}
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch (err) {}
  process.exit(code)
}

try {
  let ver = null
  for (let i = 0; i < 80 && !ver; i++) {
    try { ver = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json() } catch (err) {}
    if (!ver) await sleep(150)
  }
  if (!ver) throw new Error('Chromium 没起来（CDP 连不上）')
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let id = 0
  const pend = new Map()
  ws.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
    let m
    try { m = JSON.parse(raw) } catch (err) { return }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
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
  // 页面上任何异常都收下来（module 内部的错误不容易从外面看出来）
  const pageErrs = []
  ws.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
    let m
    try { m = JSON.parse(raw) } catch (err) { return }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params && m.params.exceptionDetails
      pageErrs.push(String((d && ((d.exception && d.exception.description) || d.text)) || '').slice(0, 500))
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.type === 'error') {
      pageErrs.push('console.error: ' + (m.params.args || []).map((a) => a.value || a.description).join(' ').slice(0, 300))
    }
  })
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false }, sessionId, 5000).catch(() => {})
  const evaluate = async (expr, to) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId, to || 30000)
    if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text))
    return r.result && r.result.value
  }
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 }, sessionId)
      await sleep(40)
    }
    await sleep(220)
  }
  const rectOf = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: (e.textContent || '').trim() } })()`)
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId, 20000)
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  }

  console.log('\n--- 打开页面并等她加载 ---')
  await send('Page.navigate', { url: target }, sessionId, 15000).catch(() => {})
  let ready = false
  for (let i = 0; i < 80; i++) {
    try {
      const st = await evaluate('({ pet: !!window.DSHPet, err: String(window.__DSHPetError||""), smtc: !!window.dshwSongSMTC, bridge: typeof window.dshwSongBridgeTick })')
      if (st && st.pet) { ready = true; console.log('  页面就绪：' + JSON.stringify(st)); break }
      if (st && st.err) { console.log('  页面报错：' + st.err.slice(0, 400)); break }
    } catch (err) {}
    await sleep(250)
  }
  ok(ready, '桌宠前端加载完成（window.DSHPet 已挂上）', '')
  // 统一层是异步首读：等它就绪再断言（否则会误判成"没检测到播放器"）
  await evaluate('window.dshwSongSMTC ? window.dshwSongSMTC.load(true) : null', 15000)
  // 顺手把"前端看到的原始响应"打出来：读不到时能一眼看出是 401 还是空列表
  const raw = await evaluate('fetch("/dsh-pet/media?list=1").then(r => r.status + " | " + r.headers.get("content-type") + " | len=" + (r.headers.get("content-length")||"?")).catch(e => "FETCH-FAIL: " + e.message)')
  console.log('  原始响应头 /dsh-pet/media?list=1 → ' + raw)
  const rawBody = await evaluate('fetch("/dsh-pet/media?list=1").then(r => r.text()).then(t => "len=" + t.length + " body=" + t.slice(0, 180)).catch(e => "FETCH-FAIL: " + e.message)')
  console.log('  原始响应体 /dsh-pet/media?list=1 → ' + rawBody)
  const smtcSrc = await evaluate('fetch("/dsh-pet/media-smtc.js").then(r => r.text()).then(t => t.indexOf("inflight") >= 0 ? "新版（含 inflight）" : "旧版缓存！").catch(e => "FAIL " + e.message)')
  console.log('  页面拿到的 media-smtc.js：' + smtcSrc)
  const dbg = await evaluate(`(async () => {
    const api = window.dshwSongSMTC
    const out = { ready: api.ready(), players: api.players().length, enabled: api.enabled(), cookie: document.cookie.slice(0, 40) }
    try {
      const ret = api.load(true)
      out.retType = typeof ret
      out.isThenable = !!(ret && typeof ret.then === 'function')
      const r = await ret
      out.loadResult = r ? { players: (r.players || []).length } : null
    } catch (e) { out.loadErr = String((e && e.message) || e) }
    out.readyAfter = api.ready(); out.playersAfter = api.players().length
    try { const rr = await window.fetch('/dsh-pet/media?list=1'); const j = await rr.json(); out.direct = j.sessions ? j.sessions.length : -1 } catch (e) { out.directErr = String(e && e.message) }
    return JSON.stringify(out)
  })()`, 20000)
  console.log('  依赖注入排查：' + dbg)
  // 追一下"预取到底怎么了"：每秒问一次 ready/players，看它是不是永远到不了 ready
  const trace = []
  for (let i = 0; i < 5; i++) {
    trace.push(await evaluate('JSON.stringify({ t: ' + i + ', ready: window.dshwSongSMTC.ready(), players: window.dshwSongSMTC.players().length, now: !!window.dshwSongSMTC.now() })'))
    await sleep(500)
  }
  console.log('  预取轨迹：' + trace.join(' → '))
  console.log('  页面异常/console.error：' + JSON.stringify(pageErrs))
  // 最终定位手段：把 window.fetch 包起来记账，看模块到底发没发请求、拿到的 status 是多少
  const fm = await evaluate(`(async () => {
    const log = []
    const orig = window.fetch
    window.fetch = function (u, i) {
      const rec = { url: String(u), status: 'pending' }
      log.push(rec)
      try {
        const p = orig.apply(window, arguments)
        if (p && p.then) p.then((r) => { rec.status = r.status }, (e) => { rec.status = 'ERR ' + (e && e.message) })
        return p
      } catch (e) { rec.status = 'THROW ' + (e && e.message); throw e }
    }
    const api = window.dshwSongSMTC
    const r = await api.load(true)
    await new Promise((res) => setTimeout(res, 800))
    window.fetch = orig
    // 只留最近 6 条，别把日志刷爆
    return JSON.stringify({ fetches: log.slice(-6), totalFetches: log.length, loadResult: r ? Object.keys(r) : null, ready: api.ready(), players: api.players().length })
  })()`, 20000)
  console.log('  fetch 记账：' + fm)
  const api = await evaluate('({ smtc: !!window.dshwSongSMTC, players: (window.dshwSongSMTC && window.dshwSongSMTC.players()) ? window.dshwSongSMTC.players().length : -1, now: window.dshwSongSMTC ? window.dshwSongSMTC.now() : null, sessions: (window.dshwSongSMTC && window.dshwSongSMTC.players()) || [] })')
  console.log('  统一层现场：' + JSON.stringify(api))
  ok(api && api.smtc === true, '统一层前端已挂上（window.dshwSongSMTC）', JSON.stringify(api && api.smtc))
  ok(api && api.players > 0, '前端已从宿主读到媒体会话（' + (api && api.players) + ' 个）', JSON.stringify(api && api.now))
  ok(api && api.now && api.now.ok === true && !!api.now.player, '当前曲目归到了某个播放器：' + (api && api.now && api.now.player), JSON.stringify(api && api.now))

  // 她可能默认缩在角落：先确保可见
  await evaluate('(() => { try { window.DSHPet.setHidden(false) } catch (e) {} return true })()')
  await sleep(600)

  console.log('\n--- 真点一次：⋯ 菜单 → 音乐页签 ---')
  const dock = await evaluate('(() => { const b = document.querySelectorAll(".dshp-dock button"); return { count: b.length, labels: Array.from(b).map(x => x.title || x.textContent) } })()')
  console.log('  底部按钮：' + JSON.stringify(dock))
  const menuBtn = await rectOf('.dshp-dock button:nth-child(2)')
  ok(!!menuBtn, '找到 ⋯ 菜单按钮', JSON.stringify(menuBtn))
  if (menuBtn) await clickAt(menuBtn.x, menuBtn.y)
  const opened = await evaluate('window.DSHPet.menu().open')
  ok(opened === true, '菜单已打开（真鼠标点出来的）', String(opened))

  const tab = await rectOf('.dshp-tab-btn[data-tab="music"]')
  ok(!!tab, '找到「音乐」页签按钮', JSON.stringify(tab))
  // 点页签要重试：面板刚展开时可能还在重排/夹回视口，第一下偶尔落在旧坐标上（实测会这样）
  let focused = null
  for (let attempt = 0; attempt < 4 && focused !== 'music'; attempt++) {
    const t = await rectOf('.dshp-tab-btn[data-tab="music"]')
    if (t) await clickAt(t.x, t.y)
    await sleep(300)
    focused = await evaluate('window.DSHPet.menu().focused')
    if (focused !== 'music') await sleep(400)
  }
  const m = await evaluate('window.DSHPet.menu()')
  ok(m && m.focused === 'music', '页签切到 music（DSHPet.menu().focused）', JSON.stringify(m && m.focused))
  const chips = (m && m.chips) || []
  console.log('  音乐页上的按钮：' + JSON.stringify(chips.map((c) => c.label)))
  ok(chips.some((c) => /网易云音乐|QQ音乐|PotPlayer|Edge|Chrome|VLC|Spotify/.test(c.label)),
    '页面上列出了检测到的播放器', JSON.stringify(chips.map((c) => c.label)))
  ok(chips.some((c) => c.on === true), '当前生效的那个是高亮的（on:true）', JSON.stringify(chips.filter((c) => c.on)))
  ok(chips.some((c) => /播放·暂停/.test(c.label)), '遥控按钮在（播放·暂停）', '')

  const file = await shot(path.join(OUT_DIR, 'music-pane.png'))
  console.log('\n  截图：' + file)

  console.log('\n--- 本地音乐栏（宿主自己的播放器）---')
  {
    const local = await evaluate(`(() => {
      const api = window.dshwSongLocal
      if (!api) return { present: false }
      const st = api.state() || {}
      return { present: true, ok: !!st.ok, tracks: (st.tracks || []).length, managed: st.managed || '', names: (st.tracks || []).map((t) => t.name).slice(0, 5), error: st.error || '' }
    })()`)
    console.log('  media-local 现场：' + JSON.stringify(local))
    ok(local && local.present === true, '本地音乐前端已挂上（window.dshwSongLocal）', JSON.stringify(local))
    ok(local && local.tracks > 0, '读到本地歌单（' + (local && local.tracks) + ' 首：' + ((local && local.names) || []).join(',') + '）', JSON.stringify(local && local.error))
    const paneText = await evaluate('window.DSHPet.menu().chips.map(function (c) { return c.label }).join(" | ")')
    // 「本地音乐」是小标题（hint），不在 chips 里；chips 里应当能看到本地播放键与曲目
    ok(/本地播放/.test(String(paneText)), '本地音乐栏有播放按钮', String(paneText).slice(0, 220))
    const paneHints = await evaluate('Array.from(document.querySelectorAll(".dshp-hint")).map(function (e) { return e.textContent }).join(" | ")')
    ok(/本地音乐/.test(String(paneHints)), '音乐页里出现了「本地音乐」那一栏的标题', String(paneHints).slice(0, 220))
    ok(/本地音乐 · \d+ 首/.test(String(paneHints)), '写明本地歌单有几首', String(paneHints).slice(0, 220))
    // 真点一次本地播放：<audio> 的 src 应当指向 music-file?id=… 且真的开始播。
    // 点之前必须确认"按钮真的在视口里"——音乐页东西多，按钮可能被排到面板外，
    // 那时鼠标事件落在别的元素上（实测踩过：点了没反应，以为是逻辑坏了）。
    let playing = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const info = await evaluate(`(() => {
        const bs = Array.from(document.querySelectorAll('.dshp-chip'))
        const b = bs.find((x) => /本地播放/.test(x.textContent))
        if (!b) return { found: false }
        const r = b.getBoundingClientRect()
        const x = r.x + r.width / 2
        const y = r.y + r.height / 2
        const top = document.elementFromPoint(x, y)
        return {
          found: true, x: x, y: y,
          inViewport: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
          rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) },
          viewportH: innerHeight,
          hitIsSelf: !!top && (top === b || b.contains(top)),
          hitTag: top ? (top.className || top.tagName) : null,
        }
      })()`)
      if (attempt === 0) console.log('  按钮定位：' + JSON.stringify(info))
      if (!info || !info.found) break
      if (!info.hitIsSelf) {
        // 被挡/在滚动容器的可见区之外：先滚到中间再重新取坐标（elementFromPoint 会自证命中）
        await evaluate(`(() => {
          const bs = Array.from(document.querySelectorAll('.dshp-chip'))
          const b = bs.find((x) => /本地播放/.test(x.textContent))
          if (b && b.scrollIntoView) b.scrollIntoView({ block: 'center' })
          return true
        })()`)
        await sleep(400)
        const re = await evaluate(`(() => {
          const bs = Array.from(document.querySelectorAll('.dshp-chip'))
          const b = bs.find((x) => /本地播放/.test(x.textContent))
          const r = b.getBoundingClientRect()
          const x = r.x + r.width / 2, y = r.y + r.height / 2
          const top = document.elementFromPoint(x, y)
          return { x: x, y: y, hitIsSelf: !!top && (top === b || b.contains(top)) }
        })()`)
        if (attempt === 0 && re) console.log('  滚动后重取坐标：' + JSON.stringify(re))
        if (re) { info.x = re.x; info.y = re.y }
      }
      await clickAt(info.x, info.y)
      await sleep(1200)
      playing = await evaluate(`(() => {
        const a = window.dshwSongLocal.audio()
        const st = window.dshwSongLocal.state()
        return { hasAudio: !!a, src: a ? String(a.src) : '', paused: a ? a.paused : null, index: st.index, playing: st.playing, error: st.error || '' }
      })()`)
      if (playing && playing.hasAudio && playing.paused === false) break
      // 鼠标没打中就滚动后再来一次
      await evaluate('document.querySelectorAll(".dshp-panel").forEach(function (p) { p.scrollTop = p.scrollTop + 120 }); true')
      await sleep(300)
    }
    console.log('  播放现场：' + JSON.stringify(playing))
    ok(playing && playing.hasAudio === true && /music-file\?id=/.test(String(playing.src)),
      '<audio> 指向音乐文件的 Range 接口', JSON.stringify(playing && playing.src))
    ok(playing && playing.paused === false, '真点一次「本地播放」→ 真的开始播（paused=false）', JSON.stringify(playing))
    const fileLocal = await shot(path.join(OUT_DIR, 'music-pane-local.png'))
    console.log('  截图：' + fileLocal)
    // 收尾：暂停，别在主人机器上留声音
    await evaluate('window.dshwSongLocal.pause()')
    const stopped = await evaluate('window.dshwSongLocal.audio() ? window.dshwSongLocal.audio().paused : null')
    ok(stopped === true, '收尾：已暂停（不在主人机器上留声音）', String(stopped))
  }

  /**
   * 可靠点击：先把元素滚进滚动容器的可见区，再用 elementFromPoint 自证命中，然后发真鼠标事件。
   * 为什么必须这样：音乐页内容比容器的 258px 高，不滚的话按钮落在可见区之外 ——
   * 鼠标事件会落到 BODY 上（实测：点了没反应，还以为是功能坏了）。
   */
  const clickElementByText = async (re) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const info = await evaluate(`(() => {
        const bs = Array.from(document.querySelectorAll('.dshp-chip, .dshp-btn'))
        const b = bs.find((x) => ${re}.test(x.textContent))
        if (!b) return { found: false }
        if (b.scrollIntoView) b.scrollIntoView({ block: 'center' })
        const r = b.getBoundingClientRect()
        const x = r.x + r.width / 2, y = r.y + r.height / 2
        const top = document.elementFromPoint(x, y)
        return { found: true, x: x, y: y, hitIsSelf: !!top && (top === b || b.contains(top)), hitTag: top ? String(top.className || top.tagName).slice(0, 30) : null }
      })()`)
      if (!info || !info.found) return { found: false }
      if (!info.hitIsSelf) { await sleep(350); continue }
      await clickAt(info.x, info.y)
      return { found: true, clicked: true, x: info.x, y: info.y }
    }
    return { found: true, clicked: false }
  }

  console.log('\n--- 真点一次遥控按钮（toggle）---')
  const before = await evaluate('window.dshwSongSMTC.now()')
  const ctl = chips.find((c) => /播放·暂停/.test(c.label))
  if (ctl) {
    // 先把 fetch 记账装上：控制没生效时，能看出是"没发出去"还是"发了被拒"
    await evaluate(`(() => {
      window.__probeNet = []
      const orig = window.fetch
      window.fetch = function (u, i) {
        const rec = { url: String(u), method: (i && i.method) || 'GET', body: (i && i.body) || '', status: 'pending' }
        window.__probeNet.push(rec)
        const p = orig.apply(window, arguments)
        if (p && p.then) p.then((r) => { rec.status = r.status }, (e) => { rec.status = 'ERR ' + (e && e.message) })
        return p
      }
      return true
    })()`)
    const clicked = await clickElementByText('/播放·暂停/')
    console.log('  遥控按钮点击：' + JSON.stringify(clicked))
    await sleep(2500)
    const after = await evaluate('window.dshwSongSMTC.now()')
    const posts = await evaluate('JSON.stringify((window.__probeNet || []).filter(function (r) { return r.method === "POST" }))')
    let post = null
    try { post = (JSON.parse(posts) || [])[0] || null } catch (err) {}
    console.log('  目标会话：' + JSON.stringify(before && { player: before.player, app: before.app, playing: before.playing }))
    console.log('  点击后的网络：' + posts)
    console.log('  点击后的状态：' + JSON.stringify(after && { player: after.player, playing: after.playing }))
    ok(!!post && post.url === '/dsh-pet/media' && post.status === 200,
      '点按钮真的发了控制 POST 并拿到 200', JSON.stringify(post))
    let sentBody = null
    try { sentBody = JSON.parse(post && post.body) } catch (err) {}
    ok(!!sentBody && sentBody.cmd === 'toggle', 'POST 体是 {cmd:"toggle"}（由宿主翻成 play/pause）', JSON.stringify(sentBody))
    // 浏览器里的媒体会话经常**不接受**外部暂停（实测 Edge 那条就拒了），所以这里只作观察记录，
    // 不做硬断言；真正的"状态翻转"由下面的 --live-control（真播放器，需显式授权）证明。
    console.log('  观察：' + ((after && after.playing) !== (before && before.playing)
      ? '状态翻转了（这个播放器接受外部控制）'
      : '状态没变 —— 这个会话是浏览器（Edge/Chrome），实测它不接受外部暂停；宿主侧确实回了 ok'))

    // 观察即可（不断言）：不同播放器对自己"能不能被外部控制"的回答不一样 ——
    // 真机实测：网易云会真的翻转；浏览器那条（Edge）经常回 ok 但状态不动。
    console.log('  观察：' + ((after && after.playing) !== (before && before.playing)
      ? ('状态翻转了（' + (before && before.player) + ' 接受外部控制）')
      : ('状态没变 —— ' + (before && before.player) + ' 这次没接受外部控制（宿主侧确实回了 ok；' +
         '真机实测网易云通常能翻，浏览器会话常常不行）')))

    // 复原：**只在真的翻转了**才需要点回去 —— 浏览器会话本来就不接受外部控制（状态没变），
    // 再点一次反而是多余的（还可能因为 SMTC 状态回读慢造成假失败）。
    // 真机实测：网易云的 pause 很稳，play 偶尔会有一两秒延迟，所以这里**重试两次**；
    // 两次都没回来就照实报"可能还停在暂停"，不留假绿。
    const flipped = (after && after.playing) !== (before && before.playing)
    let restored = await evaluate('window.dshwSongSMTC.now()')
    if (flipped) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (restored && before && restored.playing === before.playing) break
        await clickElementByText('/播放·暂停/')
        await sleep(2500)
        restored = await evaluate('window.dshwSongSMTC.now()')
      }
    }
    const backToBefore = !!restored && !!before && restored.playing === before.playing
    if (flipped && !backToBefore) {
      console.log('  ⚠️ 复原没成功：' + JSON.stringify({ before: before && before.playing, now: restored && restored.playing, player: before && before.player })
        + '（这台播放器偶发不接受外部 play；请手动点一下播放）')
    }
    ok(flipped ? backToBefore : true,
      flipped ? '再点一次回到点击前的状态（不留副作用）' : '没翻转时无需复原（状态保持原样）',
      JSON.stringify({ flipped: flipped, before: before && before.playing, restored: restored && restored.playing }))

    if (LIVE_CONTROL) {
      console.log('\n--- --live-control：在真播放器上完整来回（反向命令 → 验证 → 复原）---')
      console.log('  （需要显式授权：会短暂改变那个播放器的播放状态，结束后复原）')
      const cand = await evaluate(`(async () => {
        const r = await fetch('/dsh-pet/media?list=1').then((x) => x.json())
        const sess = (r && r.sessions) || []
        const browser = /edge|chrome|firefox|msedge/i
        const pick = sess.find((s) => !browser.test(s.appId || ''))
        return pick ? { app: pick.appId, title: pick.title, status: pick.status } : null
      })()`, 20000)
      console.log('  选中：' + JSON.stringify(cand))
      if (!cand) {
        console.log('  跳过：只有浏览器会话（它们不接受外部控制）')
      } else {
        const cmd = (cand.status === 'Playing') ? 'pause' : 'play'
        const p2 = await evaluate(`fetch('/dsh-pet/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: ${JSON.stringify(cmd)}, app: ${JSON.stringify(cand.app)} }) }).then((r) => r.json())`, 20000)
        console.log('  发 ' + cmd + ' → ' + JSON.stringify(p2))
        ok(!!p2 && p2.ok === true && p2.did === cmd, '宿主回 ok:true 且 did=' + cmd, JSON.stringify(p2))
        await sleep(900)
        const st1 = await evaluate(`fetch('/dsh-pet/media?app=' + encodeURIComponent(${JSON.stringify(cand.app)})).then((r) => r.json())`, 20000)
        console.log('  验证：' + JSON.stringify(st1 && st1.nowPlaying))
        ok(!!st1 && !!st1.nowPlaying && st1.nowPlaying.status === (cmd === 'play' ? 'Playing' : 'Paused'),
          '真机状态真的翻了（' + (cmd === 'play' ? 'Playing' : 'Paused') + '）', JSON.stringify(st1 && st1.nowPlaying))
        const back = (cmd === 'play') ? 'pause' : 'play'
        const p3 = await evaluate(`fetch('/dsh-pet/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: ${JSON.stringify(back)}, app: ${JSON.stringify(cand.app)} }) }).then((r) => r.json())`, 20000)
        await sleep(900)
        const st2 = await evaluate(`fetch('/dsh-pet/media?app=' + encodeURIComponent(${JSON.stringify(cand.app)})).then((r) => r.json())`, 20000)
        console.log('  复原 ' + back + ' → ' + JSON.stringify(p3) + ' / ' + JSON.stringify(st2 && st2.nowPlaying))
        ok(!!st2 && !!st2.nowPlaying && st2.nowPlaying.status === cand.status && st2.nowPlaying.title === cand.title,
          '复原成功：曲目与状态与操作前一致（' + cand.status + '）', JSON.stringify(st2 && st2.nowPlaying))
      }
    }
  } else {
    ok(false, '找到「播放·暂停」按钮用于真实遥控验证', 'chips=' + JSON.stringify(chips.map((c) => c.label)))
  }

  const file2 = await shot(path.join(OUT_DIR, 'music-pane-after.png'))
  console.log('  截图：' + file2)

  console.log('\n结果：pass ' + pass + ' / fail ' + fail)
  cleanup(fail ? 1 : 0)
} catch (err) {
  console.log('\n探针失败：' + ((err && err.stack) || err))
  cleanup(3)
}
