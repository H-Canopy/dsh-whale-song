// ============================================================================
// test-music-pane.mjs —— 「音乐」页签的行为测试（不需要浏览器）
// ----------------------------------------------------------------------------
// 为什么要单独测它：宿主插件只在**启动时**加载，改完前端要重启 DSH 才看得到 ——
// 而重启 DSH 等于掐掉主人正在用的会话。所以这里把 pet.js 里那段页签代码抠出来，
// 用桩替掉她的 DOM 小工具（$ / ui / CFG / persistCfg），直接断言：
//   · 统一层有数据时：列出各播放器、当前生效的高亮、点一下＝固定跟随、可取消跟随
//   · 统一层没有时：退回挂件的显示与遥控（旧行为不许破）
//   · 开关关掉时：明确说出来，而不是假装"没在放"
//
// 跑：node tools/test-music-pane.mjs
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '..', 'assets', 'pet.js'), 'utf8')

// —— 从 pet.js 里抠出「音乐」页签那一段 ——
const a = src.indexOf('// —— 鲸歌（dsh-whale-song）增量 ③：独立的「音乐」页签 ——')
const b = src.indexOf('if (id === \'face\')', a)
if (a < 0 || b < 0) throw new Error('在 pet.js 里找不到「音乐」页签块（标记被改动过？）')
const block = src.slice(a, src.lastIndexOf('\n', b))

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  ok   ' + msg) }
  else { fail++; failures.push(msg); console.log('  FAIL ' + msg + (detail === undefined ? '' : '  → ' + detail)) }
}

/** 给抠出来的这一段造一个可断言的假 DOM */
function makeEnv(opts) {
  const o = opts || {}
  function mkEl(tag, cls, text) {
    const el = {
      tag, cls: cls || '', text: text === undefined || text === null ? '' : String(text),
      children: [], title: '', listeners: {},
      appendChild(c) { this.children.push(c); return c },
      append(...cs) { for (const c of cs) this.children.push(c) },
      addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn) },
      click() { for (const fn of (this.listeners.click || [])) fn({ stopPropagation() {} }) },
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c) },
        remove(c) { this._set.delete(c) },
        contains(c) { return this._set.has(c) },
        toggle(c, on) { if (on === undefined) { if (this._set.has(c)) this._set.delete(c); else this._set.add(c) } else if (on) this._set.add(c); else this._set.delete(c) },
      },
    }
    if (cls) for (const c of String(cls).split(/\s+/).filter(Boolean)) el.classList.add(c)
    return el
  }
  const panes = mkEl('div', 'dshp-panes')
  const bubbles = []
  const picks = []
  const ctlCalls = []
  const cfg = { songSystemMedia: o.systemMedia === undefined ? true : o.systemMedia }
  const smtc = o.smtc === null ? null : Object.assign({
    // 真实实现里 enabled() 会去问 pet.js 的 dshwSongPrefs()（也就是 CFG），所以桩也照这个走：
    // 否则"关掉开关"这条测的就只是桩自己，测不到页签的判断。
    enabled: () => cfg.songSystemMedia !== false,
    players: () => [],
    current: () => null,
    picked: () => '',
    pick: (app) => { picks.push(app); return app },
    prettyName: (id) => String(id).replace(/\.exe$/i, ''),
    control: (cmd) => Promise.resolve({ ok: true, did: cmd }),
  }, o.smtc || {})

  const ctx = {
    console,
    window: Object.assign({}, o.window || {}),
    $: mkEl,
    ui: { menu: { panes }, bubble: { show: (t, op) => bubbles.push({ text: t, opts: op }) }, focused: 'music' },
    CFG: cfg,
    persistCfg: () => {},
    clampPanels: () => {},
    requestAnimationFrame: (fn) => fn(),
  }
  if (smtc) ctx.window.dshwSongSMTC = smtc
  vm.createContext(ctx)
  // pet.js 里 panes 是 renderPane 的局部变量（const panes = ui.menu.panes），抠出来的片段依赖它，
  // 所以包一层同名常量还原那个作用域。
  vm.runInContext('function renderPane(id){\nconst panes = ui.menu.panes;\n' + block + '\n}\n;globalThis.__render = renderPane;', ctx)
  const render = () => {
    panes.children.length = 0
    panes.text = ''
    ctx.__render('music')
    return panes.children.slice()
  }
  /** 把一棵假 DOM 拍平成文本，方便断言"页面上写了什么" */
  const flat = (nodes) => nodes.map((n) => {
    const kids = flat(n.children || [])
    const own = (n.text === undefined || n.text === null) ? '' : String(n.text)
    return [own, kids].filter((s) => s && String(s).trim()).join(' ')
  }).join('\n')
  const buttons = (nodes) => {
    const out = []
    const walk = (list) => { for (const n of list) { if (n.tag === 'button') out.push(n); walk(n.children || []) } }
    walk(nodes)
    return out
  }
  return { render, flat, buttons, bubbles, picks, ctlCalls, panes, ctx, mkEl }
}

console.log('\n--- 统一层有数据：列播放器 + 当前生效高亮 ---')
{
  const env = makeEnv({
    smtc: {
      players: () => [
        { app: 'cloudmusic.exe', name: '网易云音乐', title: '人间灯火', artist: 'MAD', status: 'Playing', playing: true },
        { app: 'PotPlayerMini64.exe', name: 'PotPlayer', title: '', artist: '', status: 'Paused', playing: false },
      ],
      current: () => ({ app: 'cloudmusic.exe', name: '网易云音乐', title: '人间灯火', artist: 'MAD', status: 'Playing', playing: true }),
    },
  })
  const nodes = env.render()
  const text = env.flat(nodes)
  ok(/检测到 2 个播放器/.test(text), '一行说明列出了几个播放器', text.slice(0, 120))
  ok(/跟随系统/.test(text), '默认状态写明是"跟随系统"', text.slice(0, 120))
  ok(/人间灯火/.test(text) && /网易云音乐/.test(text), '写明正在放什么、哪个播放器', text.slice(0, 200))

  const bs = env.buttons(nodes)
  const cloud = bs.find((b) => b.text.indexOf('网易云音乐') >= 0)
  const pot = bs.find((b) => b.text.indexOf('PotPlayer') >= 0)
  ok(!!cloud && !!pot, '两个播放器各出一个按钮', bs.map((b) => b.text).join(' / '))
  ok(!!cloud && cloud.classList.contains('dshp-on') && cloud.text.indexOf('●') === 0,
    '当前生效的那个：高亮 + ●', cloud && cloud.text)
  ok(!!pot && !pot.classList.contains('dshp-on'), '另一个不高亮', pot && pot.text)
  ok(!!cloud && /人间灯火/.test(cloud.title), '悬停能看到它在放什么', cloud && cloud.title)
  ok(!bs.some((b) => b.text.indexOf('跟随系统') >= 0), '没固定时不出"跟随系统"按钮（没得取消）', bs.map((b) => b.text).join(' / '))
}

console.log('\n--- 点一下＝固定跟随；再点＝取消 ---')
{
  const env = makeEnv({
    smtc: {
      players: () => [
        { app: 'cloudmusic.exe', name: '网易云音乐', title: '人间灯火', artist: '', status: 'Paused', playing: false },
        { app: 'PotPlayerMini64.exe', name: 'PotPlayer', title: '电影', artist: '', status: 'Playing', playing: true },
      ],
      current: () => ({ app: 'PotPlayerMini64.exe', name: 'PotPlayer', title: '电影', artist: '', status: 'Playing', playing: true }),
    },
  })
  let nodes = env.render()
  const cloud = env.buttons(nodes).find((b) => b.text.indexOf('网易云音乐') >= 0)
  cloud.click()
  ok(env.picks[0] === 'cloudmusic.exe', '点非当前项 ⇒ pick(那个 app)', JSON.stringify(env.picks))

  // 模拟"已经固定了"：picked 与 current 都指向它，并带上取消按钮
  const env2 = makeEnv({
    smtc: {
      players: () => [{ app: 'cloudmusic.exe', name: '网易云音乐', title: '人间灯火', artist: '', status: 'Paused', playing: false }],
      current: () => ({ app: 'cloudmusic.exe', name: '网易云音乐', title: '人间灯火', artist: '', status: 'Paused', playing: false }),
      picked: () => 'cloudmusic.exe',
    },
  })
  nodes = env2.render()
  const text = env2.flat(nodes)
  ok(/已固定跟随/.test(text), '固定后说明写明"已固定跟随"', text.slice(0, 120))
  const auto = env2.buttons(nodes).find((b) => b.text.indexOf('跟随系统') >= 0)
  ok(!!auto, '固定后出现「跟随系统」按钮', env2.buttons(nodes).map((b) => b.text).join(' / '))
  auto.click()
  ok(env2.picks[0] === '', '点「跟随系统」⇒ pick(空串)＝取消固定', JSON.stringify(env2.picks))

  const fixed = env2.buttons(nodes).find((b) => b.text.indexOf('网易云音乐') >= 0)
  fixed.click()
  ok(env2.picks[1] === 'cloudmusic.exe', '已固定的那个再点一下＝取消（pick 传空串）', JSON.stringify(env2.picks))
}

console.log('\n--- 遥控按钮：走统一层，并把结果冒成气泡 ---')
{
  const env = makeEnv({
    smtc: {
      players: () => [{ app: 'cloudmusic.exe', name: '网易云音乐', title: 'X', artist: '', status: 'Playing', playing: true }],
      current: () => ({ app: 'cloudmusic.exe', name: '网易云音乐', title: 'X', artist: '', status: 'Playing', playing: true }),
      control: (cmd) => Promise.resolve({ ok: true, did: cmd }),
    },
  })
  const nodes = env.render()
  const toggle = env.buttons(nodes).find((b) => b.text.indexOf('播放·暂停') >= 0)
  ok(!!toggle, '有「播放·暂停」按钮', env.buttons(nodes).map((b) => b.text).join(' / '))
  toggle.click()
  await new Promise((r) => setTimeout(r, 5))
  ok(/播放·暂停 ✓/.test(env.bubbles.map((b) => b.text).join(' ')), '成功：冒一条"… ✓"气泡', JSON.stringify(env.bubbles.map((b) => b.text)))

  // 失败要说话：把宿主的人话 reason 冒出来，而不是假装成功
  const env2 = makeEnv({
    smtc: {
      players: () => [{ app: 'cloudmusic.exe', name: '网易云音乐', title: 'X', artist: '', status: 'Paused', playing: false }],
      current: () => ({ app: 'cloudmusic.exe', name: '网易云音乐', title: 'X', artist: '', status: 'Paused', playing: false }),
      control: () => Promise.resolve({ ok: false, error: 'no-session', reason: '没找到在放东西的播放器' }),
    },
  })
  const t2 = env2.buttons(env2.render()).find((b) => b.text.indexOf('下一首') >= 0)
  t2.click()
  await new Promise((r) => setTimeout(r, 5))
  ok(/没找到在放东西的播放器/.test(env2.bubbles.map((b) => b.text).join(' ')), '失败：冒宿主的 reason（人话）', JSON.stringify(env2.bubbles.map((b) => b.text)))
}

console.log('\n--- 没有统一层：退回挂件（旧行为不许破）---')
{
  const env = makeEnv({
    smtc: null,
    window: {
      dshwMediaNow: () => ({ ok: true, source: 'radio', title: 'SomaFM', artist: '', playing: true }),
      dshwMediaCtl: (cmd) => { env.ctlCalls.push(cmd); return { ok: true } },
    },
  })
  const nodes = env.render()
  const text = env.flat(nodes)
  ok(/SomaFM/.test(text) && /在线电台/.test(text), '显示挂件当前音源（电台）', text.slice(0, 160))
  const prev = env.buttons(nodes).find((b) => b.text.indexOf('上一首') >= 0)
  prev.click()
  ok(env.ctlCalls[0] === 'prev', '遥控仍打到 window.dshwMediaCtl', JSON.stringify(env.ctlCalls))
  ok(/上一首 ✓/.test(env.bubbles.map((b) => b.text).join(' ')), '同步返回也照旧冒气泡', JSON.stringify(env.bubbles.map((b) => b.text)))
}

console.log('\n--- 统一层被关掉 / 没检测到播放器 ---')
{
  const off = makeEnv({
    systemMedia: false,
    smtc: { players: () => [{ app: 'cloudmusic.exe', name: '网易云音乐', title: 'X', status: 'Playing', playing: true }] },
  })
  const textOff = off.flat(off.render())
  ok(/设置里关掉/.test(textOff) && /系统媒体读取/.test(textOff), '关掉时明说"设置里关掉了"（不假装没在放）', textOff.slice(0, 160))
  ok(!off.buttons(off.render()).some((b) => b.text.indexOf('网易云音乐') >= 0), '关掉时列不出播放器', '')

  const empty = makeEnv({ smtc: { players: () => [], current: () => null } })
  const textEmpty = empty.flat(empty.render())
  ok(/还没检测到/.test(textEmpty), '没会话时给出"打开播放器放一首"的提示', textEmpty.slice(0, 160))
  ok(/现在没在放什么/.test(textEmpty), '并说明现在没在放', textEmpty.slice(0, 200))
  ok(empty.buttons(empty.render()).length >= 3, '遥控按钮与有没有会话无关（可用性不依赖它）', String(empty.buttons(empty.render()).length))
  // 「打开挂件面板」是**挂件专属**：没装挂件就不该出现（对第一次装的人是纯困惑）
  const emptyBtns = empty.buttons(empty.render())
  ok(emptyBtns.length === 3 && !emptyBtns.some((b) => /挂件面板/.test(b.text)),
    '没装挂件时：三个遥控按钮在，「打开挂件面板」不出现', emptyBtns.map((b) => b.text).join(' / '))
  const withWidget = makeEnv({
    smtc: { players: () => [{ app: 'cloudmusic.exe', name: '网易云音乐', title: 'X', status: 'Playing', playing: true }], current: () => null },
    window: { dshwMediaCtl: () => ({ ok: true }) },
  })
  const wBtns = withWidget.buttons(withWidget.render())
  ok(wBtns.some((b) => /挂件面板/.test(b.text)), '装了挂件时：「打开挂件面板」才出现', wBtns.map((b) => b.text).join(' / '))
}

console.log('\n结果：pass ' + pass + ' / fail ' + fail)
if (fail && failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail ? 1 : 0)
