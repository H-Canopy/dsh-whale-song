// ============================================================================
// test-media-bridge.mjs —— 媒体桥的行为测试（不需要浏览器、不需要 DSH，毫秒级）
// ----------------------------------------------------------------------------
// 为什么要有它：桥的价值全在"状态变化时做出正确反应"，而这件事在真机上验证成本高
//（要装两个插件、要真的放歌）。这里用 vm + 桩把 window/DSHPet/fetch 都替掉，
// 直接断言它的行为：没她时安静、有她时换表情推简报、同状态不重复、暂停/切歌分得清、
// 兜底路由能用、调试开关生效。
//
// 跑：node tools/test-media-bridge.mjs
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'assets', 'media-bridge.js')
const src = fs.readFileSync(SRC, 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  ok   ' + msg) }
  else { fail++; failures.push(msg); console.log('  FAIL ' + msg + (detail ? '  → ' + detail : '')) }
}

/** 造一个隔离环境：window / fetch / 定时器全部可控 */
function makeEnv(opts) {
  const o = opts || {}
  const calls = []
  const timers = { intervals: 0, timeouts: 0 }
  const win = {
    DSHPet: {
      setUserFace: (m) => calls.push({ kind: 'face', mood: m }),
      report: (t, b) => calls.push({ kind: 'report', title: t, body: b }),
      playMotion: (g) => calls.push({ kind: 'motion', group: g }),
    },
  }
  const ctx = {
    window: win,
    console,
    setInterval: (fn, ms) => { timers.intervals++; timers.lastInterval = fn; return 1 },
    setTimeout: () => { timers.timeouts++; return 1 },
    fetch: o.fetch || (() => Promise.resolve({ ok: false, json: () => Promise.resolve(null) })),
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  return { win, calls, timers, tick: () => win.dshwSongBridgeTick() }
}

const localProvider = (over) => Object.assign({
  ok: true, source: 'local', title: '测试曲', artist: '测试歌手',
  detail: '', playing: true, body: '正在播放：测试曲 — 测试歌手\n音源：本地音乐',
}, over || {})

console.log('\n--- 媒体桥：启动与静默 ---')
{
  const env = makeEnv()
  ok(env.timers.intervals === 1, '启动了轮询定时器', 'intervals=' + env.timers.intervals)
  ok(env.timers.timeouts >= 1, '安排了一次首帧同步', 'timeouts=' + env.timers.timeouts)

  // 她不在（没装桌宠）：应当一声不响，也不能抛错
  env.win.DSHPet = undefined
  env.win.dshwMediaNow = () => localProvider()
  let threw = null
  try { env.tick() } catch (err) { threw = err }
  ok(!threw, '她不在时：不抛错', threw && threw.message)
  ok(env.calls.length === 0, '她不在时：一次都不调用', 'calls=' + env.calls.length)
}

console.log('\n--- 媒体桥：有她 + 挂件接口 ---')
{
  const env = makeEnv()
  env.win.dshwMediaNow = () => localProvider()
  env.tick()
  const face = env.calls.filter((c) => c.kind === 'face').pop()
  const rep = env.calls.filter((c) => c.kind === 'report').pop()
  ok(!!face && face.mood === 'happy', '开始播放 → 换表情 happy', face && face.mood)
  ok(!!rep && String(rep.body).indexOf('测试曲') >= 0 && String(rep.title).indexOf('正在播放') >= 0,
    '开始播放 → 推简报（标题=正在播放、正文带曲名）', rep && rep.title + ' / ' + String(rep.body).split('\n')[0])
  ok(env.calls.filter((c) => c.kind === 'motion').length === 0, '首次同步不演动作（避免一打开就蹦）', '')

  const before = env.calls.length
  env.tick()
  ok(env.calls.length === before, '同一状态不重复播报（去重）', 'before=' + before + ' after=' + env.calls.length)

  // 切歌（播放中、曲名变了）→ 应当额外演动作
  env.win.dshwMediaNow = () => localProvider({ title: '第二首', body: '正在播放：第二首\n音源：本地音乐' })
  env.tick()
  ok(env.calls.filter((c) => c.kind === 'motion').length === 1, '切歌 → 演一次动作', 'motions=' + env.calls.filter((c) => c.kind === 'motion').length)

  // 暂停 → sleepy
  env.win.dshwMediaNow = () => localProvider({ playing: false, body: '已暂停：第二首\n音源：本地音乐' })
  env.tick()
  const face2 = env.calls.filter((c) => c.kind === 'face').pop()
  ok(!!face2 && face2.mood === 'sleepy', '暂停 → 换表情 sleepy', face2 && face2.mood)

  // 电台 → listening + 简报里带 ICY
  env.win.dshwMediaNow = () => localProvider({ source: 'radio', title: 'SomaFM Groove Salad', detail: 'Some Artist - Some Track', body: '' })
  env.tick()
  const face3 = env.calls.filter((c) => c.kind === 'face').pop()
  const rep3 = env.calls.filter((c) => c.kind === 'report').pop()
  ok(!!face3 && face3.mood === 'listening', '电台 → 换表情 listening', face3 && face3.mood)
  ok(!!rep3 && String(rep3.body).indexOf('正在播：Some Artist') >= 0, '电台 → 简报里带 ICY 正在播的曲目', rep3 && String(rep3.body).replace(/\n/g, ' | '))
}

console.log('\n--- 媒体桥：没挂件接口时走宿主路由兜底 ---')
{
  let asked = null
  const env = makeEnv({
    fetch: (u) => {
      asked = u
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, nowPlaying: { title: '网易云上的歌', artist: '某歌手', status: 'Playing' } }),
      })
    },
  })
  env.win.dshwMediaNow = undefined
  env.tick()
  await new Promise((r) => setTimeout(r, 10))   // 等 promise 链
  ok(asked === '/dsh-whale/netease.json', '兜底去读挂件宿主的路由', String(asked))
  const face = env.calls.filter((c) => c.kind === 'face').pop()
  const rep = env.calls.filter((c) => c.kind === 'report').pop()
  ok(!!face && face.mood === 'happy', '兜底：播放中 → happy', face && face.mood)
  ok(!!rep && String(rep.body).indexOf('网易云上的歌') >= 0 && String(rep.body).indexOf('音源：网易云') >= 0,
    '兜底：简报里写明网易云与曲名', rep && String(rep.body).replace(/\n/g, ' | '))
}

console.log('\n--- 媒体桥：调试开关 ---')
{
  const env = makeEnv()
  env.win.dshwMediaNow = () => localProvider()
  env.win.dshwSongBridge = false
  env.tick()
  ok(env.calls.length === 0, 'window.dshwSongBridge=false 时完全不动', 'calls=' + env.calls.length)
}

console.log('\n结果：pass ' + pass + ' / fail ' + fail)
if (fail && failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail ? 1 : 0)
