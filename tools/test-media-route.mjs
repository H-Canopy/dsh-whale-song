// ============================================================================
// test-media-route.mjs —— 宿主路由 /dsh-pet/media 的行为测试（鲸歌增量）
// ----------------------------------------------------------------------------
// 为什么这样写：这条路由是"统一层"（系统媒体会话 SMTC）的唯一入口，它的价值与风险都
// 在**边界**上——白名单命令、过滤器校验、失败形状、信任栅栏。真机验证成本高（要放歌），
// 所以这里：
//   · 用真的 http 服务器 + 真的 HTTP 请求打到插件的 handler（连 body 读取一起覆盖）
//   · 用假 ctx / 假 connection 复刻 DSH 宿主，跑的是 lib/index.js 里**真代码**
//   · 只把 node:child_process 换成桩，桩会把宿主拼的参数原样记下来供断言
//   · --live 则**完全不桩**：用真 powershell 走真 SMTC，并另起进程跑真宿主链路
//
// 跑：
//   node tools/test-media-route.mjs          # 桩（毫秒级，不需要放歌）
//   node tools/test-media-route.mjs --live   # 额外打真机 SMTC（只读，不动播放状态）
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const LIVE = process.argv.includes('--live')

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  ok   ' + msg) }
  else { fail++; failures.push(msg); console.log('  FAIL ' + msg + (detail === undefined ? '' : '  → ' + detail)) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-media-route-'))
const CALLS = path.join(TMP, 'calls.jsonl')
process.env.DSH_HOME = path.join(TMP, 'dsh-home')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })

// ---------------------------------------------------------------------------
// node:child_process 的桩：宿主只用了 spawn —— 给一个够用的假 ChildProcess。
// 为什么不真起一个"假 powershell.exe"：Windows 上 .cmd/.cjs 都不是能直接 spawn 的可执行
// 体（实测 .cmd → EINVAL，.cjs → EFTYPE），为了造假助手去拼 WSH/cmd 包装只会让测试更脆。
// 打桩换来的是：参数拼接、缓存、bad-json、spawn 失败这些**宿主侧行为**全部可断言；
// 真帮手的 CLI 与真宿主链路由 --live 阶段用真 powershell 覆盖。
//
// 怎么打（踩过的两个坑）：
//   ① ESM 的 `import { spawn } from 'node:child_process'` 不经过 Module._load，registerHooks
//      在本机 Node 24 上也没被调（内置模块走 CJS 缓存快路径）。可行的是改 **CJS 里那个模块
//      对象**：createRequire 拿到的对象就是 ESM 命名导出绑定的同一个对象，改了立刻生效。
//   ② 但必须在**本文件顶部不要静态 import node:child_process 的任何成员**：一旦静态 import
//      过（例如为了 spawnSync），那个模块的 ESM 记录就被冻结成当时的快照，之后 lib/index.js
//      的命名导入会拿到**旧**的 spawn，桩就白打了（实测就是这个现象）。
//      所以这里一律走 createRequire，并且真实的 spawnSync 要在改 spawn **之前**取出来。
// ---------------------------------------------------------------------------
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const EventEmitter = require('node:events')
const cpModule = require('node:child_process')
const realSpawnSync = cpModule.spawnSync

const stub = { calls: [], mode: 'ok', status: 'Paused' }

function makeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => { child.killed = true }
  return child
}
function stubSpawn(exe, args) {
  try { fs.appendFileSync(CALLS, JSON.stringify(args) + '\n') } catch (err) {}
  stub.calls.push({ exe, args: args.slice() })
  const child = makeChild()
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : '' }
  const cmd = get('-Cmd')
  const app = get('-App')
  const list = args.includes('-List')
  setImmediate(() => {
    if (stub.mode === 'crash') {
      const err = new Error('spawn ENOENT')
      err.code = 'ENOENT'
      child.emit('error', err)
      return
    }
    if (stub.mode === 'badjson') {
      child.stdout.emit('data', Buffer.from('not json at all\n', 'utf8'))
      child.emit('close', 0)
      return
    }
    let out
    if (stub.mode === 'nosession') out = { ok: false, error: 'no-session' }
    else if (list) out = { ok: true, sessions: [
      { appId: 'cloudmusic.exe', title: '人间灯火', artist: 'MAD', status: 'Paused' },
      { appId: 'MSEdge', title: 'Edge 视频', artist: '', status: 'Playing' },
    ] }
    else if (cmd === 'get' && app === 'nothing-here') out = { ok: true, nowPlaying: null }
    else if (cmd === 'get') out = { ok: true, nowPlaying: {
      appId: app === 'MSEdge' ? 'MSEdge' : 'cloudmusic.exe',
      title: '人间灯火', artist: 'MAD', status: stub.status,
    } }
    else out = { ok: true, did: cmd, appId: app === 'MSEdge' ? 'MSEdge' : 'cloudmusic.exe' }
    child.stdout.emit('data', Buffer.from(JSON.stringify(out) + '\n', 'utf8'))
    child.emit('close', 0)
  })
  return child
}
const realSpawn = cpModule.spawn
cpModule.spawn = stubSpawn
if (cpModule.default) cpModule.default.spawn = stubSpawn
// 兜底自检：宿主真的拿到桩了吗（拿不到就直接判失败，别让测试静默走真机）
const spawnInUse = () => cpModule.spawn === stubSpawn

// ---------------------------------------------------------------------------
// 假宿主：复刻 DSH 的 ctx（webServer.register / connection / effect / get）
// ---------------------------------------------------------------------------
function makeCtx(routes, rejection) {
  return {
    webServer: {
      port: 41999,
      register(r) { routes.push(r); return () => {} },
      tapIndex() { return () => {} },
    },
    connection: { requestRejection: rejection || (() => null) },
    effect(fn) { return fn() },
    get(name) { return name === 'connection' ? this.connection : undefined },
    on() {},
    logger: console,
  }
}

const routes = []
const plugin = (await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)).default
plugin.apply(makeCtx(routes))
ok(spawnInUse(), '前置自检：宿主的 spawn 已经被换成桩（否则后面全是真机读数）', String(spawnInUse()))

if (!routes.some((r) => r.path === '/dsh-pet/media')) {
  console.log('致命：/dsh-pet/media 没注册上（routes=' + routes.map((r) => r.path).join(',') + '）')
  process.exit(1)
}

const server = http.createServer((req, res) => {
  for (const r of routes) {
    const hit = r.kind === 'exact' ? req.url.split('?')[0] === r.path : req.url.startsWith(r.path)
    if (hit) { r.handler(req, res); return }
  }
  res.writeHead(404).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = 'http://127.0.0.1:' + server.address().port

async function call(method, url, body) {
  const init = { method, headers: {} }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const r = await fetch(BASE + url, init)
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch (err) {}
  return { status: r.status, json, text }
}
function stubCalls() {
  try { return fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch (err) { return [] }
}
function clearStubCalls() { fs.writeFileSync(CALLS, '') }

// ---------------------------------------------------------------------------
console.log('\n--- GET：会话列表 ---')
{
  const r = await call('GET', '/dsh-pet/media?list=1')
  ok(r.status === 200 && r.json && r.json.ok === true, '列表：200 + ok:true', r.status + ' ' + r.text.slice(0, 120))
  ok(Array.isArray(r.json.sessions) && r.json.sessions.length === 2, '列表：回两个会话', JSON.stringify(r.json.sessions))
  const s0 = r.json.sessions && r.json.sessions[0]
  ok(!!s0 && s0.appId === 'cloudmusic.exe' && s0.title === '人间灯火' && 'status' in s0 && 'artist' in s0,
    '列表：每行的字段是 appId/title/artist/status', JSON.stringify(s0))
  const calls = stubCalls()
  ok(calls.length === 1 && calls[0].includes('-List') && calls[0].includes('get'),
    '列表：宿主只调一次助手，且带 -List', JSON.stringify(calls))
  await call('GET', '/dsh-pet/media?list=1')
  ok(stubCalls().length === 1, '列表：5 秒内走缓存（不再起进程）', 'calls=' + stubCalls().length)
}

console.log('\n--- GET：当前曲目 ---')
{
  clearStubCalls()
  const r = await call('GET', '/dsh-pet/media')
  ok(r.status === 200 && r.json.ok === true && r.json.nowPlaying && r.json.nowPlaying.title === '人间灯火',
    '默认读：拿到当前曲目', r.text.slice(0, 140))
  const first = stubCalls()[0]
  ok(first && !first.includes('-App'), '默认读：**不带** -App（助手沿用"只网易云"的安全默认）', JSON.stringify(first))
  ok(first && first.join('|').includes('smtc-helper.ps1') && first.includes('-NoProfile') && first.includes('Bypass'),
    '宿主调用形态：-NoProfile -ExecutionPolicy Bypass -File smtc-helper.ps1', JSON.stringify(first))
  await call('GET', '/dsh-pet/media?app=MSEdge')
  const second = stubCalls()[1]
  ok(second && second.includes('-App') && second.includes('MSEdge'), '?app=MSEdge：把过滤器交给助手', JSON.stringify(second))
  const r2 = await call('GET', '/dsh-pet/media?app=MSEdge')
  ok(r2.json.nowPlaying && r2.json.nowPlaying.appId === 'MSEdge', '?app=MSEdge：回的 appId 是 Edge 那一路', JSON.stringify(r2.json.nowPlaying))
}

console.log('\n--- GET：没在放东西与失败形状 ---')
{
  const r = await call('GET', '/dsh-pet/media?app=nothing-here')
  ok(r.status === 200 && r.json.ok === true && r.json.nowPlaying === null,
    '没有会话：ok:true + nowPlaying:null（不是错误）', r.text.slice(0, 120))
  const rn = await call('GET', '/dsh-pet/media?app=nothing-here&list=0&x=1')
  ok(rn.json.ok === true, '多余查询参数不影响（只有 app/list 有意义）', rn.text.slice(0, 100))
  stub.mode = 'nosession'
  const r3 = await call('POST', '/dsh-pet/media', { cmd: 'pause', app: 'nothing-here' })
  ok(r3.status === 200 && r3.json.ok === false && r3.json.error === 'no-session' && typeof r3.json.reason === 'string' && r3.json.reason.length > 0,
    '控制失败：ok:false + error:no-session + 人话 reason', r3.text.slice(0, 160))
  stub.mode = 'ok'
}

console.log('\n--- POST：控制 ---')
{
  clearStubCalls()
  stub.status = 'Paused'
  const r = await call('POST', '/dsh-pet/media', { cmd: 'play' })
  ok(r.status === 200 && r.json.ok === true && r.json.did === 'play', 'play：ok:true + did:play', r.text.slice(0, 140))
  ok(r.json.requested === 'play' && typeof r.json.appId === 'string', 'play：回 requested 与真正接单的 appId', JSON.stringify(r.json))
  const calls = stubCalls()
  ok(calls.length === 1 && calls[0].includes('-Cmd') && calls[0].includes('play'),
    'play：只发一次控制调用（不需要先读状态）', JSON.stringify(calls))

  clearStubCalls()
  const rn = await call('POST', '/dsh-pet/media', { cmd: 'next' })
  ok(rn.json.ok === true && rn.json.did === 'next', 'next：ok:true + did:next', rn.text.slice(0, 120))

  clearStubCalls()
  const rp = await call('POST', '/dsh-pet/media', { cmd: 'pause', app: 'MSEdge' })
  const pCalls = stubCalls()
  ok(rp.json.ok === true && !!pCalls[0] && pCalls[0].includes('MSEdge'), 'pause + app：app 透传到控制命令', JSON.stringify(pCalls[0] || pCalls))
  ok(rp.json.appId === 'MSEdge', 'pause + app：回执里说明是哪个播放器接的单', JSON.stringify(rp.json))
}

console.log('\n--- POST：toggle 的翻译与缓存作废 ---')
{
  // 读缓存 TTL 只有 1.5 秒，而一次往返就是几毫秒 —— 只要"先 GET 再 POST"，
  // POST 里的那次状态读必然命中缓存，所以"起了几个进程"是可数的。
  stub.status = 'Paused'
  clearStubCalls()
  await call('GET', '/dsh-pet/media?app=stub-toggle-1', undefined)
  const before = stubCalls().length
  const r = await call('POST', '/dsh-pet/media', { cmd: 'toggle', app: 'stub-toggle-1' })
  ok(r.json.ok === true && r.json.did === 'play' && r.json.requested === 'toggle',
    '暂停时 toggle → 翻成 play（并回 requested:toggle）', JSON.stringify(r.json))
  const tail = stubCalls().slice(before)
  ok(tail.length === 1 && tail[0].includes('play'),
    'toggle：状态读命中缓存，只发一次控制调用', JSON.stringify(tail))

  // 读缓存：连着读两次，第二次不该再起进程
  //（注意：**控制之后**的读一定不会命中缓存——那是设计要求的作废逻辑，见下一条）
  clearStubCalls()
  await call('GET', '/dsh-pet/media?app=stub-toggle-c', undefined)
  const afterFirst = stubCalls().length
  await call('GET', '/dsh-pet/media?app=stub-toggle-c', undefined)
  ok(afterFirst === 1 && stubCalls().length === 1, '读缓存：1.5 秒内第二次读不再调助手',
    'first=' + afterFirst + ' total=' + stubCalls().length)

  // 没缓存时：toggle 必须先读一次状态再控制（两次调用），否则不知道翻成什么
  stub.status = 'Playing'
  clearStubCalls()
  await call('GET', '/dsh-pet/media?app=stub-toggle-2', undefined)
  const b2 = stubCalls().length
  const r2 = await call('POST', '/dsh-pet/media', { cmd: 'toggle', app: 'stub-toggle-2' })
  ok(r2.json.did === 'pause', '播放中 toggle → 翻成 pause', JSON.stringify(r2.json))
  const t2 = stubCalls().slice(b2)
  ok(t2.length === 1 && t2[0].includes('pause'), '播放中 toggle：控制调用是 pause', JSON.stringify(t2))

  // 控制后读缓存必须作废：换状态再读，必须能读到新的（而不是旧的缓存）
  stub.status = 'Paused'
  clearStubCalls()
  const r3 = await call('GET', '/dsh-pet/media?app=stub-toggle-2', undefined)
  ok(stubCalls().length === 1 && r3.json.nowPlaying.status === 'Paused',
    '控制后读缓存被作废（下一次 GET 真的重新读，拿到新状态）', 'calls=' + stubCalls().length + ' status=' + (r3.json.nowPlaying && r3.json.nowPlaying.status))
  stub.status = 'Paused'
}

console.log('\n--- 边界：白名单 / 校验 / 方法 ---')
{
  clearStubCalls()
  const bad = await call('POST', '/dsh-pet/media', { cmd: 'rm -rf /' })
  ok(bad.status === 400 && bad.json.ok === false && bad.json.error === 'bad-cmd',
    '命令不在白名单：400 + bad-cmd', bad.status + ' ' + bad.text.slice(0, 120))
  ok(stubCalls().length === 0, '非白名单命令：**根本没起进程**（零注入面）', 'calls=' + stubCalls().length)
  let allRejected = true
  for (const cmd of ['format', 'exec', 'play;rm', 'PLAY']) {
    const r = await call('POST', '/dsh-pet/media', { cmd })
    if (!(r.status === 400 && r.json.error === 'bad-cmd')) allRejected = false
  }
  ok(allRejected, '白名单拦住：format / exec / play;rm / 大写 PLAY 全被拒')

  const badApp = await call('GET', '/dsh-pet/media?app=' + encodeURIComponent('a"(evil)'))
  ok(badApp.status === 200 && badApp.json.error === 'bad-app' && badApp.json.reason && badApp.json.reason.length > 0,
    'app 含引号/括号：bad-app（不透传给 PowerShell）', badApp.text.slice(0, 120))
  const badApp2 = await call('GET', '/dsh-pet/media?app=' + 'a'.repeat(200))
  ok(badApp2.json.error === 'bad-app', 'app 超长（200 字符）：bad-app', badApp2.text.slice(0, 80))
  const badApp3 = await call('POST', '/dsh-pet/media', { cmd: 'play', app: 'a b; whoami' })
  ok(badApp3.json.error === 'bad-app', 'POST 的 app 也过同一套校验（分号被拒）', badApp3.text.slice(0, 120))
  const okApp = await call('GET', '/dsh-pet/media?app=' + encodeURIComponent('potplayer|vlc'))
  ok(okApp.json.ok === true, 'app 允许的形态：potplayer|vlc 通过', okApp.text.slice(0, 100))

  const del = await call('DELETE', '/dsh-pet/media')
  ok(del.status === 405, '只允许 GET/POST：DELETE → 405', String(del.status))
  const noCmd = await call('POST', '/dsh-pet/media', {})
  ok(noCmd.status === 400 && noCmd.json.error === 'bad-cmd', 'POST 不带 cmd：400 + bad-cmd', noCmd.text.slice(0, 80))
  const badJson = await fetch(BASE + '/dsh-pet/media', { method: 'POST', body: '{oops', headers: { 'Content-Type': 'application/json' } })
  ok(badJson.status === 400, 'POST 坏 JSON：400（不炸路由）', String(badJson.status))
}

console.log('\n--- 失败路径：助手吐非 JSON / 起不来 ---')
{
  // 换新的 app 过滤器 ⇒ 新的缓存键，免得被前面的缓存挡掉（也就测不到失败路径了）
  stub.mode = 'badjson'
  const r = await call('GET', '/dsh-pet/media?app=stub-fail-a')
  ok(r.json.ok === false && r.json.error === 'bad-json' && /看不懂/.test(r.json.reason),
    '助手吐非 JSON：ok:false + bad-json + 人话 reason', r.text.slice(0, 160))
  stub.mode = 'crash'
  const r2 = await call('GET', '/dsh-pet/media?app=stub-fail-b')
  ok(r2.json.ok === false && r2.json.error === 'spawn-failed' && /PowerShell/.test(r2.json.reason),
    '起不了 PowerShell：ok:false + spawn-failed（不抛 500）', r2.text.slice(0, 160))
  clearStubCalls()
  await call('GET', '/dsh-pet/media?app=stub-fail-c')
  await call('GET', '/dsh-pet/media?app=stub-fail-c')
  ok(stubCalls().length === 2, '失败的读结果不进缓存（每次重试）', 'calls=' + stubCalls().length)
  stub.mode = 'ok'
}

console.log('\n--- 信任栅栏：route() 包装必须过一遍 ---')
{
  const routes2 = []
  let rejectionCalls = 0
  plugin.apply(makeCtx(routes2, () => { rejectionCalls++; return 401 }))
  const r2 = routes2.find((r) => r.path === '/dsh-pet/media')
  ok(!!r2, '第二次挂载：/dsh-pet/media 仍然注册', String(!!r2))
  const server2 = http.createServer((req, res) => r2.handler(req, res))
  await new Promise((r) => server2.listen(0, '127.0.0.1', r))
  const res2 = await fetch('http://127.0.0.1:' + server2.address().port + '/dsh-pet/media', { method: 'GET' })
  ok(res2.status === 401 && rejectionCalls > 0, '被栅栏拒绝时：401（媒体路由不绕过信任检查）', String(res2.status))
  await new Promise((r) => server2.close(r))
}

await new Promise((r) => server.close(r))

// ---------------------------------------------------------------------------
// --live：真帮手的 CLI + 真宿主的完整链路（只读；不动播放状态）
// ---------------------------------------------------------------------------
if (LIVE) {
  console.log('\n--- live：真机 SMTC（只读） ---')
  const helper = path.join(ROOT, 'lib', 'smtc-helper.ps1')
  const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const run = (args) => {
    const r = realSpawnSync(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, ...args], { encoding: 'utf8' })
    let json = null
    try { json = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/)[0]) } catch (err) {}
    return { json, raw: String(r.stdout || '').trim() }
  }
  const g = run(['-Cmd', 'get'])
  ok(!!g.json && g.json.ok === true, '真机 -Cmd get：出一行可解析 JSON', g.raw.slice(0, 160))
  ok(!g.json.nowPlaying || (g.json.nowPlaying.appId || '').toLowerCase().includes('cloudmusic'),
    '真机默认只认网易云（appId=' + ((g.json.nowPlaying && g.json.nowPlaying.appId) || 'null') + '）', g.raw.slice(0, 160))
  const l = run(['-Cmd', 'get', '-List'])
  ok(!!l.json && l.json.ok === true && Array.isArray(l.json.sessions),
    '真机 -List：sessions 是数组（' + ((l.json && l.json.sessions && l.json.sessions.length) || 0) + ' 个会话）', l.raw.slice(0, 200))
  const any = run(['-Cmd', 'get', '-App', '.*'])
  ok(!!any.json && any.json.ok === true, '真机 -App ".*"：可解析', any.raw.slice(0, 160))
  const none = run(['-Cmd', 'get', '-App', 'no-such-player-xyz'])
  ok(!!none.json && none.json.ok === true && none.json.nowPlaying === null,
    '真机 -App 不存在的播放器：nowPlaying:null（不发散）', none.raw.slice(0, 160))
  const bad = run(['-Cmd', 'get', '-App', '('])
  ok(!!bad.json && bad.json.ok === true && bad.json.nowPlaying === null,
    '真机 -App 非法正则：按"没匹配"处理（不炸、不挂）', bad.raw.slice(0, 160))

  // 真宿主链路：另起一个进程（**这一份不经过 registerHooks**），真 powershell + 真 SMTC
  const liveScript = path.join(TMP, 'live-host.mjs')
  fs.writeFileSync(liveScript, [
    "import http from 'node:http'",
    "import { pathToFileURL } from 'node:url'",
    'const routes = []',
    'const ctx = {',
    '  webServer: { port: 41997, register(r) { routes.push(r); return () => {} }, tapIndex() { return () => {} } },',
    '  connection: { requestRejection: () => null },',
    '  effect(fn) { return fn() },',
    "  get(n) { return n === 'connection' ? this.connection : undefined },",
    '  on() {}, logger: console,',
    '}',
    'const plugin = (await import(pathToFileURL(process.argv[2]).href)).default',
    'plugin.apply(ctx)',
    "const r = routes.find((x) => x.path === '/dsh-pet/media')",
    'const server = http.createServer((req, res) => r.handler(req, res))',
    "await new Promise((res) => server.listen(0, '127.0.0.1', res))",
    "const base = 'http://127.0.0.1:' + server.address().port",
    "const list = await (await fetch(base + '/dsh-pet/media?list=1')).json()",
    "const now = await (await fetch(base + '/dsh-pet/media')).json()",
    'server.close()',
    'process.stdout.write(JSON.stringify({ list, now }))',
    '',
  ].join('\n'))
  const liveEnv = { ...process.env }
  delete liveEnv.DSHW_PS_EXE
  const out = realSpawnSync(process.execPath, [liveScript, path.join(ROOT, 'lib', 'index.js')], { encoding: 'utf8', env: liveEnv })
  let parsed = null
  try { parsed = JSON.parse(String(out.stdout || '').split('\n').filter((l) => l.trim().startsWith('{')).pop() || 'null') } catch (err) {}
  if (!parsed) {
    ok(false, '真机走宿主路由：拿到 JSON', JSON.stringify(String(out.stdout || '').slice(-200)) + ' | ' + String(out.stderr || '').slice(-200))
  } else {
    ok(parsed.list && parsed.list.ok === true && Array.isArray(parsed.list.sessions),
      '真机走宿主路由 /dsh-pet/media?list=1：列表可读（' + ((parsed.list.sessions || []).length) + ' 个）', JSON.stringify(parsed.list).slice(0, 200))
    ok(parsed.now && parsed.now.ok === true, '真机走宿主路由 /dsh-pet/media：当前曲目可读', JSON.stringify(parsed.now).slice(0, 200))
  }
}

console.log('\n结果：pass ' + pass + ' / fail ' + fail)
if (fail && failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (err) {}
process.exit(fail ? 1 : 0)
