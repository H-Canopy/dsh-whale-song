// ============================================================================
// test-rightclick-media.mjs —— 锁住"右键双击 = 播放/暂停 走统一层"这条接线
// ----------------------------------------------------------------------------
// 为什么单独一条：这是移挂件功能时**漏接**过的真实缺陷 —— 右键双击原来只读
// `window.dshwMediaCtl`（挂件提供），没读到我们自己的 `window.dshwSongSMTC`，
// 于是**没装挂件时静默什么都不发生**（界面上完全看不出是哪里坏了）。
// 现在把真源码里的 `dshwSongToggleAny` / `dshwSongNowAny` **抠出来**跑，锁住优先级：
//   ① 有统一层 → 调统一层（不碰挂件接口）
//   ② 没有统一层 / 统一层说没在放 → 退回挂件
//   ③ 两个都没有 → 返回 null（调用方给"没检测到播放器"的提示，而不是假装成功）
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const src = fs.readFileSync(path.join(ROOT, 'assets', 'pet.js'), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  ok   ' + msg) }
  else { fail++; failures.push(msg); console.log('  FAIL ' + msg + (detail === undefined ? '' : '  → ' + detail)) }
}

/** 从真源码里抠一个函数（按 `function 名字(` 到同名顶层 `}` 结束） */
function grabFn(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('pet.js 里找不到 ' + name)
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error(name + ' 括号不配平')
}

const toggleFn = grabFn('dshwSongToggleAny')
const nowFn = grabFn('dshwSongNowAny')

function makeCtx(win) {
  const ctx = { window: Object.assign({}, win), console, JSON, String, Date }
  vm.createContext(ctx)
  vm.runInContext(toggleFn + '\n' + nowFn + '\n;globalThis.__toggle = dshwSongToggleAny; globalThis.__now = dshwSongNowAny;', ctx)
  return ctx
}

console.log('\n--- ① 有统一层：必须走统一层，且**不碰**挂件接口 ---')
{
  const calls = []
  const ctx = makeCtx({
    dshwSongSMTC: {
      control: (cmd) => { calls.push('smtc:' + cmd); return Promise.resolve({ ok: true, did: cmd }) },
      now: () => ({ ok: true, playing: true, title: '人间灯火', artist: 'MAD' }),
    },
    dshwMediaCtl: (cmd) => { calls.push('widget:' + cmd); return { ok: true } },
    dshwMediaNow: () => { calls.push('widget-now'); return { ok: true, title: '挂件的' } },
  })
  const r = vm.runInContext('__toggle()', ctx)
  ok(calls.length === 1 && calls[0] === 'smtc:toggle', '控制走的是统一层（smtc:toggle）', calls.join(' / '))
  ok(r && typeof r.then === 'function', '统一层是异步的（返回 Promise，调用方要等结果）', String(r))
  const n = vm.runInContext('__now()', ctx)
  ok(n && n.title === '人间灯火', '"在放什么"也优先统一层（拿到她的曲目）', JSON.stringify(n))
  ok(calls.indexOf('widget-now') < 0, '读状态时没有去打挂件接口', calls.join(' / '))
}

console.log('\n--- ② 没有统一层：退回挂件（已装挂件的用户不受影响）---')
{
  const calls = []
  const ctx = makeCtx({
    dshwMediaCtl: (cmd) => { calls.push('widget:' + cmd); return { ok: true, did: cmd, source: 'netease' } },
    dshwMediaNow: () => ({ ok: true, playing: false, title: '挂件的歌', artist: 'X' }),
  })
  const r = vm.runInContext('__toggle()', ctx)
  ok(calls.length === 1 && calls[0] === 'widget:toggle', '退回挂件（widget:toggle）', calls.join(' / '))
  ok(r && r.ok === true && typeof r.then !== 'function', '挂件那套是同步返回，调用方要能处理', JSON.stringify(r))
  const n = vm.runInContext('__now()', ctx)
  ok(n && n.title === '挂件的歌', '"在放什么"退回挂件', JSON.stringify(n))
}

console.log('\n--- ③ 统一层在但"没在放"：读状态时也要能退回挂件 ---')
{
  const ctx = makeCtx({
    dshwSongSMTC: { now: () => ({ ok: false, error: 'no-session' }), control: () => Promise.resolve({ ok: false, error: 'no-session' }) },
    dshwMediaNow: () => ({ ok: true, title: '挂件在放' }),
  })
  const n = vm.runInContext('__now()', ctx)
  ok(n && n.title === '挂件在放', '统一层没数据时读挂件', JSON.stringify(n))
}

console.log('\n--- ④ 两个都没有（纯独立壳、没别的插件）：返回 null，不假装成功 ---')
{
  const ctx = makeCtx({})
  const r = vm.runInContext('__toggle()', ctx)
  ok(r === null, '没有数据源时返回 null（调用方给"没检测到播放器"提示）', String(r))
  const n = vm.runInContext('__now()', ctx)
  ok(n === null, '"在放什么"返回 null', String(n))
}

console.log('\n--- ⑤ 右键处理器本身：必须走统一层这套，且异步结果要等回来再冒泡 ---')
{
  // 抠 contextmenu 处理器里"双击"那一段，断言它用的是 dshwSongToggleAny 而不是裸的 dshwMediaCtl
  const at = src.indexOf("dshwRightTrace('double'")
  const seg = at >= 0 ? src.slice(at, at + 1600) : ''
  ok(seg.length > 0, '找得到右键双击那段代码', String(seg.length))
  ok(/dshwSongToggleAny\(\)/.test(seg), '右键双击用的是 dshwSongToggleAny()（统一层优先）', '')
  ok(!/typeof window\.dshwMediaCtl === 'function'\) \? window\.dshwMediaCtl\('toggle'\)/.test(seg),
    '不再直接裸调挂件的 dshwMediaCtl("toggle")（那就是漏接的写法）', '')
  ok(/typeof r\.then === 'function'/.test(seg), '异步结果用 .then 接（否则气泡永远显示"不可用"）', '')
  ok(/ui\.bubble\.show\(msg/.test(seg), '结果会冒成气泡（用户看得见回应）', '')
}

console.log('\n结果：pass ' + pass + ' / fail ' + fail)
if (fail && failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail ? 1 : 0)
