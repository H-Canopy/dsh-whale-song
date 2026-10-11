// ============================================================================
// test-media-smtc.mjs —— 统一层前端 media-smtc.js 的行为测试（不需要浏览器/宿主）
// ----------------------------------------------------------------------------
// 它值钱的地方全在"判断"上：谁算当前播放器、固定跟随之后还算不算数、
// 关掉开关是不是真的一次请求都不发、控制命令发的是不是宿主认的那几个值。
// 用 vm + 桩把 window/fetch/localStorage/定时器都替掉，毫秒级直测这些判断。
//
// 跑：node tools/test-media-smtc.mjs
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'assets', 'media-smtc.js')
const src = fs.readFileSync(SRC, 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  ok   ' + msg) }
  else { fail++; failures.push(msg); console.log('  FAIL ' + msg + (detail === undefined ? '' : '  → ' + detail)) }
}
const flush = () => new Promise((r) => setTimeout(r, 5))

/** 造一个隔离环境：会话列表由 sessions() 现算，fetch 记下每次请求 */
function makeEnv(opts) {
  const o = opts || {}
  const calls = []
  const store = {}
  const timers = { intervals: 0, timeouts: 0, lastInterval: null }
  const sessions = () => (typeof o.sessions === 'function' ? o.sessions() : (o.sessions || []))
  const win = {
    fetch: (url, init) => {
      calls.push({ url: String(url), init: init || null })
      if (String(url).indexOf('list=1') >= 0) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, sessions: sessions() }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, did: 'x', appId: 'cloudmusic.exe', reason: '' }),
      })
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
    },
  }
  if (o.prefs) win.dshwSongPrefs = () => o.prefs
  const ctx = {
    window: win,
    console,
    Promise,
    Date,
    JSON,
    setInterval: (fn, ms) => { timers.intervals++; timers.lastInterval = fn; return 1 },
    setTimeout: (fn, ms) => { timers.timeouts++; return 1 },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  return { win, api: win.dshwSongSMTC, calls, store, timers, sessions }
}

const listCalls = (calls) => calls.filter((c) => c.url.indexOf('list=1') >= 0)
const postCalls = (calls) => calls.filter((c) => c.init && c.init.method === 'POST')

console.log('\n--- 启动与静默 ---')
{
  const env = makeEnv({ sessions: [] })
  ok(!!env.api && typeof env.api.now === 'function', '挂上了 window.dshwSongSMTC', String(!!env.api))
  ok(env.timers.intervals === 1, '启动了一个轮询定时器', 'intervals=' + env.timers.intervals)
  ok(env.timers.timeouts >= 1, '安排了一次首帧刷新', 'timeouts=' + env.timers.timeouts)
  ok(env.api.now() === null, '还没读到就返回 null（不编状态）')
  await flush()
  ok(listCalls(env.calls).length >= 1, '后台会去读会话列表', JSON.stringify(env.calls.map((c) => c.url)))
  ok(env.api.now() === null, '列表为空时仍然 null', JSON.stringify(env.api.players()))
}

console.log('\n--- 形态：和挂件 dshwMediaNow() 对齐 ---')
{
  const env = makeEnv({
    sessions: () => [
      { appId: 'cloudmusic.exe', title: '人间灯火', artist: 'MAD', status: 'Playing' },
      { appId: 'MSEdge', title: '某个视频', artist: '', status: 'Paused' },
    ],
  })
  env.api.tick()
  await flush()
  const now = env.api.now()
  ok(!!now && now.ok === true, '读到状态', JSON.stringify(now))
  ok(now && now.source === 'system', "source 标成 'system'（媒体桥据此挑名字）", String(now && now.source))
  ok(now && now.title === '人间灯火' && now.artist === 'MAD', '曲名/歌手照搬会话', JSON.stringify(now))
  ok(now && now.playing === true, 'status=Playing ⇒ playing:true', JSON.stringify(now))
  ok(now && now.player === '网易云音乐', 'appId 换成人话名字', String(now && now.player))
  ok(now && now.app === 'cloudmusic.exe', 'app 原样保留（给控制命令用）', String(now && now.app))
}

console.log('\n--- 选"当前生效"：正在播的优先，其次有曲目的 ---')
{
  const env = makeEnv({
    sessions: () => [
      { appId: 'PotPlayerMini64.exe', title: '', artist: '', status: 'Paused' },
      { appId: 'QQMusic.exe', title: '某首歌', artist: '某歌手', status: 'Playing' },
    ],
  })
  env.api.tick()
  await flush()
  ok(env.api.now().player === 'QQ音乐', '两个会话：挑正在播的那个', String(env.api.now().player))

  env.win.fetch = null
  const env2 = makeEnv({
    sessions: () => [
      { appId: 'PotPlayerMini64.exe', title: '', artist: '', status: 'Paused' },
      { appId: 'vlc.exe', title: '暂停中的片子', artist: '', status: 'Paused' },
    ],
  })
  env2.api.tick()
  await flush()
  ok(env2.api.now().player === 'VLC', '都在暂停：挑有曲目的那个（不是空会话）', String(env2.api.now().player))

  const env3 = makeEnv({ sessions: () => [{ appId: 'weird-player.exe', title: 'X', status: 'Paused' }] })
  env3.api.tick()
  await flush()
  ok(env3.api.now().player === 'weird-player', '不认识的 appId：去掉 .exe 当名字（不瞎猜）', String(env3.api.now().player))

  const env4 = makeEnv({ sessions: () => [{ appId: 'MSEdge', title: '视频', status: 'Playing' }] })
  env4.api.tick()
  await flush()
  ok(env4.api.now().player === 'Edge', 'MSEdge → Edge', String(env4.api.now().player))
}

console.log('\n--- 固定跟随某个播放器 ---')
{
  const env = makeEnv({
    sessions: () => [
      { appId: 'cloudmusic.exe', title: '网易云的歌', artist: '', status: 'Playing' },
      { appId: 'PotPlayerMini64.exe', title: '电影', artist: '', status: 'Paused' },
    ],
  })
  env.api.tick()
  await flush()
  ok(env.api.now().app === 'cloudmusic.exe', '默认跟随：正在播的网易云', String(env.api.now().app))
  env.api.pick('PotPlayerMini64.exe')
  ok(env.store.dshwSongPlayer === 'PotPlayerMini64.exe', '固定选择写进 localStorage', JSON.stringify(env.store))
  env.api.tick()
  await flush()
  ok(env.api.now().app === 'PotPlayerMini64.exe', '固定之后：即使它在暂停也用它', String(env.api.now().app))
  ok(env.api.now().playing === false, '固定之后状态照实报（paused）', String(env.api.now().playing))

  // 固定的那个退出了：不发散到别的播放器（宁可安静，也别突然遥控别人）
  const env2 = makeEnv({
    sessions: () => [{ appId: 'cloudmusic.exe', title: '别的歌', artist: '', status: 'Playing' }],
    prefs: { systemMedia: true },
  })
  env2.api.pick('PotPlayerMini64.exe')
  env2.api.tick()
  await flush()
  ok(env2.api.now() === null, '固定的播放器不在会话里：返回 null（不偷偷换人）', JSON.stringify(env2.api.current()))

  env2.api.pick('')
  env2.api.tick()
  await flush()
  ok(env2.api.now() && env2.api.now().app === 'cloudmusic.exe', '取消固定：回到"谁在放跟谁"', JSON.stringify(env2.api.now()))
  ok(env2.store.dshwSongPlayer === '', '取消固定也写盘（空串）', JSON.stringify(env2.store))
}

console.log('\n--- 设置里关掉：一次请求都不发 ---')
{
  const env = makeEnv({ sessions: () => [{ appId: 'cloudmusic.exe', title: 'X', status: 'Playing' }], prefs: { systemMedia: false } })
  ok(env.api.enabled() === false, 'enabled() 反映设置', String(env.api.enabled()))
  env.api.tick()
  await flush()
  ok(env.calls.length === 0, '关掉后不读列表（零请求）', 'calls=' + env.calls.length)
  ok(env.api.now() === null, '关掉后 now() 恒 null', String(env.api.now()))
  const r = await env.api.control('play')
  ok(r && r.ok === false && r.error === 'disabled', '关掉后控制也被拦住', JSON.stringify(r))
  ok(env.calls.length === 0, '关掉后连控制都不发请求', 'calls=' + env.calls.length)
}

console.log('\n--- 控制命令 ---')
{
  const env = makeEnv({ sessions: () => [{ appId: 'cloudmusic.exe', title: 'X', status: 'Playing' }] })
  env.api.tick()
  await flush()
  const before = env.calls.length
  const r = await env.api.control('toggle')
  const p = postCalls(env.calls)
  ok(p.length === 1, 'control 发一次 POST', JSON.stringify(p.map((c) => c.url)))
  ok(p[0].url === '/dsh-pet/media', 'POST 打到宿主路由 /dsh-pet/media', String(p[0].url))
  ok(p[0].init.method === 'POST' && /application\/json/.test(p[0].init.headers['Content-Type']), 'POST 带 JSON 头', JSON.stringify(p[0].init.headers))
  let sent = null
  try { sent = JSON.parse(p[0].init.body) } catch (err) {}
  ok(sent && sent.cmd === 'toggle', '命令名原样发给宿主', JSON.stringify(sent))
  ok(sent && !('app' in sent), '跟随系统时不带 app（宿主的"当前生效"语义）', JSON.stringify(sent))
  ok(r && r.ok === true, '返回值透传宿主结果', JSON.stringify(r))
  ok(env.calls.length > before, '控制后本地缓存被作废（下一次读会重新请求）', 'calls=' + env.calls.length)

  // 固定跟随之后：控制命令必须带 app，否则会去遥控"当前生效"的那个（用户没选它）
  env.api.pick('MSEdge')
  const p2 = postCalls(env.calls).pop()
  await env.api.control('next')
  const p3 = postCalls(env.calls).pop()
  ok(p3 !== p2, '又发了一次 POST', String(p3 && p3.url))
  let sent2 = null
  try { sent2 = JSON.parse(p3.init.body) } catch (err) {}
  ok(sent2 && sent2.cmd === 'next' && sent2.app === 'MSEdge', '固定跟随时带 app（只动那一个）', JSON.stringify(sent2))
}

console.log('\n--- 读失败/宿主没装：安静降级 ---')
{
  const env = makeEnv({ sessions: [] })
  env.win.fetch = () => Promise.reject(new Error('boom'))
  env.api.tick()
  await flush()
  ok(env.api.now() === null, '请求失败：now() 还是 null（不抛错）', String(env.api.now()))
  const r = await env.api.control('play')
  ok(r && r.ok === false && r.error === 'request-failed', '控制请求失败：回 ok:false + request-failed', JSON.stringify(r))

  const env2 = makeEnv({ sessions: [] })
  env2.win.fetch = undefined
  env2.api.tick()
  await flush()
  ok(env2.api.now() === null, '没有 fetch 的环境（老壳）：不炸', String(env2.api.now()))
}

console.log('\n--- 缓存：2 秒内不重复打宿主 ---')
{
  const env = makeEnv({ sessions: () => [{ appId: 'cloudmusic.exe', title: 'X', status: 'Playing' }] })
  env.api.tick()
  await flush()
  const n1 = listCalls(env.calls).length
  env.api.load()          // 命中 2 秒缓存
  env.api.load()
  await flush()
  const n2 = listCalls(env.calls).length
  ok(n1 === n2, '2 秒内的重复 load 不再发请求（前端多处调用也只发一次）', 'n1=' + n1 + ' n2=' + n2)
}

console.log('\n结果：pass ' + pass + ' / fail ' + fail)
if (fail && failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail ? 1 : 0)
