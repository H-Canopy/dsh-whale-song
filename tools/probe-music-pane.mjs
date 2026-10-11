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
    const btn = await evaluate(`(() => { const bs = Array.from(document.querySelectorAll('.dshp-chip')); const b = bs.find(x => /播放·暂停/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 } })()`)
    if (btn) await clickAt(btn.x, btn.y)
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

    // 复原：再点一次回到点击前的状态（不管刚才有没有真的翻转，都点回去，别留副作用）
    if (btn) await clickAt(btn.x, btn.y)
    await sleep(2000)
    const restored = await evaluate('window.dshwSongSMTC.now()')
    ok(!!restored && !!before && restored.playing === before.playing,
      '再点一次回到点击前的状态（不留副作用）', JSON.stringify({ before: before && before.playing, restored: restored && restored.playing }))

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
