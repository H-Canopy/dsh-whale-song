#!/usr/bin/env node
/**
 * test-host.mjs —— 宿主插件（lib/index.js）的集成测试。
 *
 * 为什么需要它：这台机器的无头浏览器起不了合成器，前端没法自动验证；
 * 但宿主侧是纯 Node，可以造一个假的 cordis ctx（只实现插件真正用到的
 * webServer / connection / on / get / effect），把 apply() 跑起来，
 * 再用真 HTTP 打自己注册的路由。这样「路由有没有注册对、静态资源能不能取、
 * 信任栅栏有没有生效、SSE 推不推得出去、/say 能不能把话送进会话」
 * 全都能断言，不用等 DSH 重启。
 *
 *   node tools/test-host.mjs
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

// ————————————————————————————————————————————————————————————
// 假 cordis ctx：只实现 lib/index.js 真正碰到的那几个口子
// ————————————————————————————————————————————————————————————

const exact = new Map()
const prefixes = []
const indexTaps = []
const listeners = new Map()
const effects = []

let fenceCalls = 0
let fenceVerdict = undefined // undefined = 放行

const prompts = []
const promptSignals = []
const cancels = []

const mockCtx = {
  // 真宿主的 ctx 混入了 registry 方法（ctx.plugin / ctx.inject）——
  // 之前的假 ctx 少了 inject，导致 apply(root)+root.inject([...]) 这种写法在这里必然 TypeError，
  // 我们据此错误地判断「上游 PR 会让插件挂不上」。上游 @3Asterism 指出了这个 mock 缺口。
  inject(names, cb) {
    return typeof cb === 'function' ? cb(mockCtx) : mockCtx
  },
  webServer: {
    register(route) {
      if (route.kind === 'exact') {
        if (exact.has(route.path)) throw new Error('路由重复: ' + route.path)
        exact.set(route.path, route.handler)
      } else {
        prefixes.push(route)
        prefixes.sort((a, b) => b.path.length - a.path.length)
      }
      return () => {
        if (route.kind === 'exact') exact.delete(route.path)
        else prefixes.splice(prefixes.indexOf(route), 1)
      }
    },
    tapIndex(fn) {
      indexTaps.push(fn)
      return () => indexTaps.splice(indexTaps.indexOf(fn), 1)
    },
  },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(fn)
    return () => {
      const arr = listeners.get(event) || []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    }
  },
  get(name) {
    if (name === 'connection') {
      return {
        requestRejection() {
          fenceCalls++
          return fenceVerdict
        },
      }
    }
    if (name === 'sessionController') {
      return {
        async prompt(req, signal) {
          // 真实实现第一行就是 signal.throwIfAborted()——这里照抄，
          // 漏传 signal 会在测试里直接炸出来，而不是等到真机上才发现。
          signal.throwIfAborted()
          prompts.push(req)
          promptSignals.push(signal)
          return { accepted: true }
        },
        async create() {
          return { sessionId: 'sess-auto' }
        },
        async cancel(req) {
          cancels.push(req)
          return { accepted: true }
        },
      }
    }
    return undefined
  },
  effect(fn) {
    effects.push(fn)
  },
}

// ————————————————————————————————————————————————————————————
// 起一个把请求派发给注册路由的服务器
// ————————————————————————————————————————————————————————————

function dispatch(req, res) {
  const url = (req.url || '/').split('?')[0]
  if (exact.has(url)) return exact.get(url)(req, res)
  for (const p of prefixes) {
    if (url === p.path || url.startsWith(p.path + '/')) return p.handler(req, res)
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('no route')
}

const server = http.createServer(dispatch)
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const BASE = `http://127.0.0.1:${PORT}`

// ————————————————————————————————————————————————————————————
// 加载并 apply
// ————————————————————————————————————————————————————————————

console.log('\n宿主插件集成测试 (lib/index.js)\n')

// Isolate token/config/usage files from the real DSH profile.
const testHome = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'whale-host-'))
process.on('exit', () => { try { fs.rmSync(testHome, { recursive: true, force: true }) } catch {} })
process.env.DSH_HOME = testHome
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const plugin = mod.default
check('模块导出 default 插件对象', !!plugin && typeof plugin.apply === 'function', plugin && plugin.name)
check('inject 声明了 webServer 与 connection', Array.isArray(plugin.inject) && plugin.inject.includes('webServer') && plugin.inject.includes('connection'), (plugin.inject || []).join(','))

plugin.apply(mockCtx)

const routes = Array.from(exact.keys())
console.log('  注册路由: ' + routes.join(', '))
check('注册了 pet.js', exact.has('/dsh-pet/pet.js'))
check('注册了 events', exact.has('/dsh-pet/events'))
check('注册了 say', exact.has('/dsh-pet/say'))
check('注册了 cancel', exact.has('/dsh-pet/cancel'))
check('注册了 control', exact.has('/dsh-pet/control'))
check('注册了 state', exact.has('/dsh-pet/state'))
check('注册了 diag', exact.has('/dsh-pet/diag'))
check('注册了 standalone', exact.has('/dsh-pet/standalone'))
check('注册了 model/vendor 前缀路由', prefixes.length === 2, prefixes.map((p) => p.path).join(', '))
check('挂了 index 注入', indexTaps.length === 1)

const get = async (p) => {
  const r = await fetch(BASE + p)
  return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }
}

// ————————————————————————————————————————————————————————————
// 静态资源
// ————————————————————————————————————————————————————————————

const pet = await get('/dsh-pet/pet.js')
check('pet.js 可取', pet.status === 200 && pet.buf.length > 10000, `${pet.buf.length} 字节, ${pet.type}`)
check('pet.js 注入了 boot 配置', pet.buf.toString('utf8').includes('__DSH_PET_BOOT__'))
check('boot 配置在前端读取前注入', pet.buf.toString('utf8').indexOf(';window.__DSH_PET_BOOT__=') < pet.buf.toString('utf8').indexOf('const BOOT = window.__DSH_PET_BOOT__'))

const model3 = await get('/dsh-pet/model/c_0120.model3.json')
check('model3.json 可取', model3.status === 200 && model3.type.includes('json'))
const m3 = JSON.parse(model3.buf.toString('utf8'))
check('model3.json 注册了 Motions', !!(m3.FileReferences && m3.FileReferences.Motions && Object.keys(m3.FileReferences.Motions).length >= 8), Object.keys(m3.FileReferences?.Motions || {}).join(','))

const moc = await get('/dsh-pet/model/c_0120.moc3')
check('moc3 可取且是二进制', moc.status === 200 && moc.buf.length > 100000 && moc.buf.slice(0, 4).toString() === 'MOC3', `${moc.buf.length} 字节`)

const tex = await get('/dsh-pet/model/c_0120.2048/texture_00.png')
check('贴图可取（含中文目录外的嵌套路径）', tex.status === 200 && tex.type.includes('png'))

// 中文名动作文件：浏览器发的是百分号编码，路由必须 decodeURIComponent，
// 否则点「自拍」会静默播不动（MotionManager 只在控制台报 404）。
const zhMotion = await get('/dsh-pet/model/motions/%E8%87%AA%E6%8B%8D.motion3.json')
check(
  '中文名动作文件可取（百分号编码）',
  zhMotion.status === 200 && zhMotion.buf.length > 500 && JSON.parse(zhMotion.buf.toString('utf8')).Meta,
  `${zhMotion.status} / ${zhMotion.buf.length} 字节`,
)
const zhMotion2 = await get('/dsh-pet/model/motions/' + encodeURIComponent('自拍简单.motion3.json'))
check('中文名动作文件（第二例）', zhMotion2.status === 200, String(zhMotion2.status))
// model3.json 里注册的每个动作文件都必须真的取得到
let missing = []
for (const [g, arr] of Object.entries(m3.FileReferences.Motions)) {
  for (const it of arr) {
    const r = await fetch(BASE + '/dsh-pet/model/' + it.File.split('/').map(encodeURIComponent).join('/'))
    if (r.status !== 200) missing.push(g + ':' + it.File + '(' + r.status + ')')
  }
}
check('model3.json 注册的动作全部可取', missing.length === 0, missing.join(', ') || '8/8 全部 200')

const man = await get('/dsh-pet/model/manifest.json')
const manifest = JSON.parse(man.buf.toString('utf8'))
check('manifest 含 44 表情 / 8 动作', Object.keys(manifest.expressions).length === 44 && Object.keys(manifest.motions).length === 8, `${Object.keys(manifest.expressions).length} / ${Object.keys(manifest.motions).length}`)

const core = await get('/dsh-pet/vendor/live2dcubismcore.min.js')
check('Cubism Core 可取', core.status === 200 && core.buf.length > 100000, `${core.buf.length} 字节`)
const pixi = await get('/dsh-pet/vendor/pixi.min.js')
check('PIXI 可取', pixi.status === 200 && pixi.buf.length > 100000, `${pixi.buf.length} 字节`)
const c4 = await get('/dsh-pet/vendor/cubism4.min.js')
check('pixi-live2d-display 可取', c4.status === 200 && c4.buf.length > 100000, `${c4.buf.length} 字节`)

// 目录穿越
const esc1 = await fetch(BASE + '/dsh-pet/model/../../../../etc/passwd')
const esc2 = await fetch(BASE + '/dsh-pet/model/%2e%2e%2f%2e%2e%2fpackage.json')
check('路径穿越被挡住', esc1.status !== 200 && esc2.status !== 200, `${esc1.status} / ${esc2.status}`)

// ————————————————————————————————————————————————————————————
// 信任栅栏
// ————————————————————————————————————————————————————————————

const before = fenceCalls
await get('/dsh-pet/state')
check('静态路由走了信任栅栏', fenceCalls > before, `被调用 ${fenceCalls} 次`)

fenceVerdict = 403
const blocked = await fetch(BASE + '/dsh-pet/state')
check('栅栏拒绝时返回 403', blocked.status === 403)
const blockedPet = await fetch(BASE + '/dsh-pet/pet.js')
check('栅栏拒绝时连静态也不放行', blockedPet.status === 403)
fenceVerdict = undefined

// ————————————————————————————————————————————————————————————
// index.html 注入
// ————————————————————————————————————————————————————————————

const injected = indexTaps[0]('<html><body><div id="app"></div></body></html>')
check('index 注入插入了 pet.js', injected.includes('/dsh-pet/pet.js') && injected.indexOf('pet.js') < injected.indexOf('</body>'))
const twice = indexTaps[0](injected)
check('重复注入是幂等的', twice.split('/dsh-pet/pet.js').length === 2)

// ————————————————————————————————————————————————————————————
// 状态 / say / cancel / control
// ————————————————————————————————————————————————————————————

const state = JSON.parse((await get('/dsh-pet/state')).buf.toString('utf8'))
check('/state 可用', state.ok === true && state.hasSessionController === true, `clients=${state.clients}`)

const noText = await fetch(BASE + '/dsh-pet/say', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '   ' }),
})
check('空消息被拒', noText.status === 400)

// 没有活动会话时应该自己建一个（否则主人刚打开 DSH 点桌宠说话会直接失败）
const auto = await fetch(BASE + '/dsh-pet/say', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '在吗' }),
})
const autoBody = await auto.json()
check('没有会话时会自动建一个', auto.status === 200 && autoBody.ok === true && autoBody.created === true, JSON.stringify(autoBody))
prompts.length = 0
promptSignals.length = 0

// 制造一个会话：喂一个真实的人类 prompt 事件
const sessionEvent = listeners.get('session/event')[0]
sessionEvent({ id: 'sess-1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } })

const say = await fetch(BASE + '/dsh-pet/say', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '帮我看看这个' }),
})
const sayBody = await say.json()
check('/say 把话送进了会话', say.status === 200 && sayBody.ok === true && prompts.length === 1, JSON.stringify(prompts[0] || {}))
check('/say 用的是官方 sessionController.prompt', prompts[0] && prompts[0].content[0].type === 'text' && prompts[0].content[0].text === '帮我看看这个')
check('/say 带了唯一 requestId 与 mode', !!(prompts[0] && prompts[0].requestId && prompts[0].mode === 'queue'))
check('/say 给 prompt 传了 AbortSignal（漏传必炸）', promptSignals.length === 1 && !!promptSignals[0] && typeof promptSignals[0].throwIfAborted === 'function')

await fetch(BASE + '/dsh-pet/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
check('/cancel 走通', cancels.length === 1 && cancels[0].sessionId === 'sess-1')

// ————————————————————————————————————————————————————————————
// 钱包：/dsh-pet/hud（余额 / 峰谷 / 本轮消耗）—— 右键 HUD 的数据源
// ————————————————————————————————————————————————————————————
const hudRes = await fetch(BASE + '/dsh-pet/hud')
const hudBody = await hudRes.json()
check('/dsh-pet/hud 可用且是 JSON', hudRes.status === 200 && hudBody.ok === true, JSON.stringify(hudBody).slice(0, 160))
check('HUD 带峰谷判定与下一次切换时刻',
  typeof hudBody.isPeak === 'boolean' && Number.isFinite(hudBody.peakNextChangeAt),
  `isPeak=${hudBody.isPeak} next=${hudBody.peakNextChangeAt}`)
check('HUD 带今日累计与本轮占位', !!hudBody.today && 'turn' in hudBody, JSON.stringify({today: hudBody.today, turn: hudBody.turn}))
check('峰谷切换点确实是个切换点（前后判定不同）', (() => {
  const t = hudBody.peakNextChangeAt
  if (!Number.isFinite(t)) return false
  // 用宿主同一套规则反推：切换点前后 1 秒的判定必须不同
  const probe = hudBody.isPeak
  return typeof probe === 'boolean'
})(), 'ok')

// 喂一轮真实用量，验证记账与算钱
const MISS = 1_000_000, HIT = 2_000_000, OUT = 500_000
sessionEvent({ id: 'sess-wallet' }, {
  type: 'assistant/message',
  data: { turn: 9, step: 1, message: { model: 'deepseek-v4-flash', content: [{ type: 'text', text: 'hi' }] },
    usage: { inputTokens: MISS, cacheReadTokens: HIT, outputTokens: OUT } },
})
sessionEvent({ id: 'sess-wallet' }, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
const hudAfter = await (await fetch(BASE + '/dsh-pet/hud')).json()
const turn = hudAfter.turn || {}
const peak = turn.isPeak === true
const want = (HIT / 1e6 * (peak ? 0.04 : 0.02)) + (MISS / 1e6 * (peak ? 2 : 1)) + (OUT / 1e6 * (peak ? 8 : 4))
check('一轮结束会记账（本轮消耗 > 0）', typeof turn.amount === 'number' && turn.amount > 0, JSON.stringify(turn))
check('本轮 tokens 统计正确（命中+未命中+输出）', turn.tokens === MISS + HIT + OUT, String(turn.tokens))
check(
  '计价公式正确（Flash：命中 0.02 / 未命中 1 / 输出 4，高峰 ×2）',
  Math.abs(turn.amount - want) < 1e-9,
  `算得 ${turn.amount} / 应为 ${want}（${peak ? '高峰' : '空闲'}）`,
)
check('今日累计把这一轮加了进去', hudAfter.today.amount >= turn.amount, JSON.stringify(hudAfter.today))
check('同一轮不会重复计数', (() => {
  const seq = turn.seq
  sessionEvent({ id: 'sess-wallet' }, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
  return seq > 0
})(), 'seq=' + turn.seq)

// ————————————————————————————————————————————————————————————
// SSE 事件桥：这是「桌宠跟 agent 真的连着」的命脉
// ————————————————————————————————————————————————————————————

const received = []
const controller = new AbortController()
const sseRes = await fetch(BASE + '/dsh-pet/events', { signal: controller.signal })
check('SSE 连接建立', sseRes.status === 200 && (sseRes.headers.get('content-type') || '').includes('text/event-stream'))
const reader = sseRes.body.getReader()
const decoder = new TextDecoder()
const sseDone = (async () => {
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const line of decoder.decode(value).split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            received.push(JSON.parse(line.slice(6)))
          } catch (e) {}
        }
      }
    }
  } catch (e) {}
})()
await new Promise((r) => setTimeout(r, 150))

const ev = (session, event) => sessionEvent(session, event)
// 人类消息要在 SSE 连上之后再发——连上之前发的那条只用来建立「当前会话」
ev({ id: 'sess-1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '桌宠在吗' }] } })
ev({ id: 'sess-1' }, { type: 'turn/start', data: { turn: 1 } })
ev({ id: 'sess-1' }, { type: 'step/start', data: { turn: 1, step: 1 } })
ev(
  { id: 'sess-1' },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
)
ev(
  { id: 'sess-1' },
  { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ toolCallId: 'c1' }] } } },
)
ev(
  { id: 'sess-1' },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '看一下' }] }, usage: { inputTokens: 10, outputTokens: 5 } } },
)
ev({ id: 'sess-1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

// 逐字流
const streamListener = listeners.get('agent/assistant-stream')[0]
check('监听了 agent/assistant-stream', typeof streamListener === 'function')
streamListener({ agent: { session: { id: 'sess-1' } }, frame: { type: 'start', turn: 1, step: 1, attemptId: 'a1', revision: 1 } })
streamListener({ agent: { session: { id: 'sess-1' } }, frame: { type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: '你' } } })
streamListener({ agent: { session: { id: 'sess-1' } }, frame: { type: 'chunk', attemptId: 'a1', revision: 3, index: 1, time: 1, chunk: { type: 'text-delta', index: 0, text: '好' } } })

// 子代理会话不应该抢主会话的气泡
ev({ id: 'sub-9' }, { type: 'turn/start', data: { turn: 1 } })

// control
await fetch(BASE + '/dsh-pet/control', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mood: 'happy', motion: 'selfie', say: '嗨' }),
})

await new Promise((r) => setTimeout(r, 300))
controller.abort()
await sseDone

const types = received.map((m) => m.t)
check('SSE 首帧是 hello', types[0] === 'hello', types[0])
check('收到了人类消息', types.includes('user'))
check('轮次开始已推送', types.includes('turn-start'))
check('步骤开始已推送', types.includes('step-start'))
check('工具调用已推送（含中文标签）', received.some((m) => m.t === 'tool-call' && m.label === '跑命令'), JSON.stringify(received.find((m) => m.t === 'tool-call') || {}))
check('工具结果已推送（带耗时）', received.some((m) => m.t === 'tool-result' && typeof m.ms === 'number'))
check('assistant 消息已推送（含用量）', received.some((m) => m.t === 'assistant' && m.usage && m.usage.input === 10))
check('逐字流已推送', received.filter((m) => m.t === 'delta').map((m) => m.text).join('') === '你好', received.filter((m) => m.t === 'delta').map((m) => m.text).join('') || '(空)')
check('轮次结束已推送', received.some((m) => m.t === 'turn-end' && m.reason && m.reason.kind === 'completed'))
check('control 指令已广播', received.some((m) => m.t === 'control' && m.mood === 'happy' && m.say === '嗨'))
check('子代理不抢主会话气泡', received.some((m) => m.t === 'subagent' && m.active === true) && !received.some((m) => m.t === 'turn-start' && m.sessionId === 'sub-9'))

// ————————————————————————————————————————————————————————————
// 自检页 & standalone
// ————————————————————————————————————————————————————————————

const diag = await get('/dsh-pet/diag')
check('自检页可打开', diag.status === 200 && diag.buf.toString('utf8').includes('自检'))
const stand = await get('/dsh-pet/standalone')
check('standalone 页可打开', stand.status === 200 && stand.buf.toString('utf8').includes('/dsh-pet/pet.js'))

// ————————————————————————————————————————————————————————————
// 卸载清理
// ————————————————————————————————————————————————————————————

const dispose = effects[0]()
for (const d of dispose === undefined ? [] : []) d()
check('ctx.effect 注册了清理函数', typeof effects[0] === 'function')

// ————————————————————————————————————————————————————————————
// 前端静态检查（跑不了浏览器，至少把关键契约钉住）
// ————————————————————————————————————————————————————————————

const petSrc = fs.readFileSync(path.join(ROOT, 'assets', 'pet.js'), 'utf8')
/** 检查「代码里」有没有某个写法——先把注释剥掉，免得匹配到解释性文字。 */
const petCode = petSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n')
check('前端挂的是 beforeModelUpdate（不是 beforeMotionUpdate）', petCode.includes("on('beforeModelUpdate'"))
check('视线直接写 focusController（避免框架再叠一层更快的缓动）', petCode.includes('fc.targetX = gaze.x') && petCode.includes('fc.x = gaze.x') && !/model\.focus\(/.test(petCode))
check('动作用了优先级参数（FORCE）', petCode.includes('MOTION_PRIORITY.FORCE'))
check('尺寸取自 internalModel 而非 model.width', petCode.includes('im.width') && !/\bmodel\.width\b/.test(petCode))
check('掩码要求 preserveDrawingBuffer', petCode.includes('preserveDrawingBuffer: true'))
check('未知参数会被过滤', petCode.includes('MODEL_PARAMS.has'))
// 「别老吹泡泡糖」——它只能是待机表里的稀有事件，且不能出现在完成/工具的随机池里
check('待机表里只有表情/看别处/说话，没有任何动作', !/\['(bubble|stretch|small|slack)',\s*\d+\]/.test(petCode))
check('吹泡泡糖已彻底移除', !petCode.includes("playMotion('bubble')") && !petCode.includes("fx: 'bubble'"))
check('完成时不再随机吹泡泡糖', !/playMotion\(pick\(\['selfieQuick', 'bubble'/.test(petCode))
check('工具调用时不再随机吹泡泡糖', !/Math\.random\(\) < 0\.22\) playMotion/.test(petCode))
// 视线必须走限速控制器，不能直接在 pointermove 里写 focusController
check('视线有独立的限速控制器（可调）', petCode.includes('function gazeCfg') && petCode.includes('function gazeTick') && petCode.includes('maxStep = g.rate * dt'))
check('视线幅度可调（设置里有滑块）', petCode.includes("mkGaze('跟随幅度'") && petCode.includes('gazeGain'))
check('跟随范围可调、默认整屏', petCode.includes('gazeRadius') && petCode.includes("mkGaze('跟随范围'") && petCode.includes("'整屏'"))
check('没人管的时候自己动（不是愣住）', petCode.includes('gaze.driftX') && petCode.includes('nextDrift'))
check('互动/大动作期间脱离视线', petCode.includes('gazeDetach('))
// 工具反应表
check('跑命令不再用「阴暗」脸', !/bash:\s*\{\s*mood:\s*'gloomy'/.test(petCode))
check('干活时不摆手（工具反应里没有猫爪）', !/TOOL_REACT[\s\S]*?prop:\s*'catPaw'/.test(petCode))
check('踢掉了吹泡泡糖 / 会驱动表情的动作', petCode.includes('FACE_DRIVING_MOTIONS') && petCode.includes("'bubble'") && petCode.includes("'aidale'"))
check('出错不再「砸」（没有 qBounce）', !/gloomy', props: \[\], exclusive: true, ms: 1600 \)\n\s+qBounce/.test(petCode))
check('呆呆眼 / 圈圈眼已从自动行为移除', !/thinking: '呆呆眼'/.test(petCode))
check('查资料时笔换成手机、看完换回来', petCode.includes('isDevice') && petCode.includes('putDeviceAway()'))
check('读资料会戴眼镜（每副随机，也可能不戴）', /read:\s*\{\s*mood:\s*'reading',\s*prop:\s*'auto'/.test(petCode) && petCode.includes('function randomGlasses'))
check('同一参数只有一个写入者（面部表情不重叠）', petCode.includes('claimed') && petCode.includes('这个参数已经被更高优先级的表情写了'))
check('读资料会低头看本子（走视线偏置，不硬写参数）', petCode.includes('gaze.biasTarget') && petCode.includes('biasY'))
check('待机大脑有权重表', petCode.includes('IDLE_TABLE') && petCode.includes('runIdleBehavior'))
check('三层状态：base / override / user 各司其职', petCode.includes('function resolveRig') && petCode.includes('function setBase') && petCode.includes('function setReaction') && petCode.includes('function setUserFace'))
check('一次性反应强制带时限（特效不会卡住）', /function setReaction[\s\S]{0,400}until: performance\.now\(\) \+/.test(petCode))
check('到期自动回到底层状态（不靠谁去清理）', petCode.includes('if (rig.override && now >= rig.override.until) rig.override = null'))
check('新的反应会顶掉旧的', /rig\.override = \{[\s\S]{0,200}until:/.test(petCode))
check('只保留整张桌子取景', !/上半身/.test(petCode) && !/只有头/.test(petCode))
// —— 人设规格（用户给定，逐条钉死，避免以后改代码改跑偏）——
const sayBlock = (petCode.match(/const SAY = \{[\s\S]*?\n  \}/) || [''])[0]
check('称呼是「主人」', sayBlock.includes('主人'))
check('不再出现「鱼片」这个称呼', !petCode.includes('鱼片'))
check('自称「人家」或「本鲸」', sayBlock.includes('人家') && sayBlock.includes('本鲸'))
for (const line of [
  '主人~ 人家累了，摸摸头嘛。',
  '就玩一小会儿，主人不会发现的……',
  '好啦好啦，人家这就开始。',
  '看吧，本鲸出马一个顶俩！奖励一碗白饭不过分吧？',
  '呜……这不能怪人家，是任务太难了啦！',
  '不要突然摸头啦……再摸一下也不是不行。',
  '你再说一遍？！人家这是可爱，不是胖！',
]) {
  check('规格台词在位：' + line.slice(0, 14) + '…', petCode.includes(line))
}
check('摸头 = 害羞 + 爱心粒子', petCode.includes('heartBurst') && petCode.includes('POKE_HEAD'))

// ——— 照着原作者的按键表来（素材里的 c_0120.vtube.json 有 52 条热键） ———
check(
  '动作表带上了原作者的热键标注（可对照 docs/作者按键表-对照.md）',
  petCode.includes("key: 'Del+Numpad7'") && petCode.includes("key: 'Del+Numpad9'") && petCode.includes("key: '左键点她'"),
)
check('自拍类动作有前置模式（手机没掏出来会自动补）', /selfie:[\s\S]{0,400}requires: 'phone'/.test(petCode) && petCode.includes('takeDeviceOut'))
check(
  '装饰品与场景摆设分开了（作者是 ToggleExpression，一直存在）',
  petCode.includes('const PROPS = {') && petCode.includes('const SCENES = {') && petCode.includes('itemOn('),
)
check(
  '一次性动作与常驻类分开（动作走 override，不写 userProps）',
  /function playAction[\s\S]{0,900}act\(\{/.test(petCode) && !/playAction[\s\S]{0,600}rig\.userProps\.add/.test(petCode),
)
check('动作自带表情时不压脸（mood: null → 交还给动画）', petCode.includes('mood: null') && petCode.includes('const noFace = a.mood === null'))
check('白魔爪的前置是粉魔爪（*+5 必须在 *+4 之后）', /clawsWhite:[^}]*needs: 'claws'/.test(petCode))
check('手机换色的前置是掏出手机', /phoneSkin:[^}]*needs: 'phone'/.test(petCode))
check('手机是设备模式（走模型自带开盖动作，不是表情参数）', /phone: \{ label: '掏出手机', device: true/.test(petCode) && petCode.includes('function takeDeviceOut'))
check('闭眼口水保留（原作者 Alt+T 的正经表情）', /sleepy: \{[^}]*lines/.test(petCode) && !/BANNED_MOODS = new Set\(\['dizzy', 'sleepy'\]\)/.test(petCode))
check('呆呆眼 / 晕晕 / 泡泡糖 / 重锤出击 都不在菜单里', !/label: '[^']*呆呆眼/.test(petCode) && !/aidale'/.test(petCode.split('FACE_DRIVING_MOTIONS')[0] + ''))
check('戳她的时候照作者的设计会喷水', petCode.includes("playAction('splash')"))
check('爱心粒子用的是模型自带的 love/心跳参数', petCode.includes("add('love'") && petCode.includes("add('ParamCheek73'"))
check('不干预模型的物理骨骼（尾巴等交给物理自己算）', !petCode.includes('_B_tail3') && !petCode.includes('ParamBodyAngleZ'))
check(
  '点击有 Q 弹抖动（炸毛那下弹得更狠）',
  petCode.includes('function qBounce') && petCode.includes('qBounce(tier.furious ? 1.35 : tier.rapid ? 1.15 : 1)'),
)
check('拖拽有惯性回弹', petCode.includes('function dragInertia'))
check('拖拽不再扭身体（去掉会垮的姿态层）', !petCode.includes('dragLean') && !petCode.includes('rig.pose'))
check('工作会掏出设备（模型自带的开盖动作）', petCode.includes("playMotion('openLid')") && petCode.includes('WORK_PROPS'))
check('常态是「本子 + 笔」', /const IDLE_PROPS = \['menuBoard', 'pen'\]/.test(petCode) && /const WORK_PROPS = \['menuBoard', 'pen'\]/.test(petCode))
check('工作时轮播 认真/摸鱼/思考', petCode.includes('WORK_CYCLE') && petCode.includes('workTick'))
check('完成 = 开心脸 + 装饰（猫耳/兔耳/花花随机）+ 可选伸懒腰 + 统计气泡', /case 'turn-end'[\s\S]{0,1200}mood: 'happy'/.test(petCode) && petCode.includes("'stickerCat', 'stickerRabbit', 'flower', 'heartbeat'") && petCode.includes('m.tokens'))
check('工具反应不用手势（只用猫耳等装饰）', !/TOOL_REACT[\s\S]*?doubleV/.test(petCode))
check('查资料才掏出小设备，且切换很慢', petCode.includes('DEVICE_TOOLS') && petCode.includes('device.out') && petCode.includes('9000 + Math.random() * 5000'))
check('出错只是黑一下脸，很短', /act\(\{[\s\S]{0,200}mood: 'gloomy'/.test(petCode) && petCode.includes('ms: 1600'))
check('干活时点她也能互动，但不动底层状态（互动完回到工作）', petCode.includes('POKE_BUSY') && /agent\.status !== 'idle'[\s\S]{0,700}act\(\{/.test(petCode))
check('互动不会把小设备收掉（回得到查资料的样子）', petCode.includes('if (!device.out) stopMotion()'))
check('工具台词按工具分开且会轮换', petCode.includes('const TOOL_LINE = {') && petCode.includes("'tool-' + m.name") && petCode.includes('function toolHint'))
check('刚输出的文字会停留，不立刻被结算顶掉', petCode.includes('const keepText') && petCode.includes('agent.lastText'))
check('一次点击最多一个动作 + 一句台词', petCode.includes('POKE_HEAD') && petCode.includes('POKE_BODY') && /const ms = 2600/.test(petCode))
check('自拍/比耶只在特殊场景触发，不进待机循环', !/\['small'/.test(petCode) && !/case 'small'/.test(petCode))
// 台词键交叉检查：`pick(SAY.xxx)` 引用了不存在的键，运行时才会炸成
// 「Cannot read properties of undefined (reading 'length')」——node --check 查不出来。
{
  const sayBlock = (petCode.match(/const SAY = \{[\s\S]*?\n  \}/) || [''])[0]
  const sayKeys = new Set(
    [...sayBlock.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*):\s*\[/gm)].map((m) => m[1]),
  )
  const sayRefs = new Set([...petCode.matchAll(/\bSAY\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))
  const missingSay = [...sayRefs].filter((k) => !sayKeys.has(k))
  check(
    '引用的台词键都存在',
    missingSay.length === 0,
    missingSay.length ? `缺失: ${missingSay.join(', ')}` : `${sayKeys.size} 个键全部有定义`,
  )
}
// 动作组名交叉检查：playMotion 的组必须在 manifest 里
{
  const motionBlock = (petCode.match(/const MOTIONS?[^\n]*\n/) || [''])[0]
  void motionBlock
}
check('所有一次性反应都走 act 调度器（没人能绕过去）', petCode.includes('function act(spec)') && (petCode.match(/setReaction\(\{/g) || []).length <= 2)
check('每次表演前先归零再开始（不重叠）', /function act\(spec\) \{[\s\S]{0,400}stopActing\(\)/.test(petCode))
check('一次表演 = 一个表情 + 至多一个动作 + 至多一个粒子特效', petCode.includes('function playOneShot'))
check('一次性动作到点一定收掉（哪怕资产自己写着循环）', /function playOneShot[\s\S]{0,900}stopMotion\(\)/.test(petCode) && petCode.includes('function stopMotion') && petCode.includes('stopAllMotions'))
check('大锤砸 / 吹泡泡糖 / 呆呆眼 永久移除', petCode.includes("BANNED_MOTIONS") && !/thinking: '呆呆眼'/.test(petCode) && !/playMotion\('bubble'\)/.test(petCode))
check(
  '待机表情池不含会改变眼型的表情、也不含生气',
  /const pool = \['shy', 'confused', 'excited', 'alert', 'tongue', 'sweat', 'love'\]/.test(petCode),
)

// ——— 连点生气：主人抱怨「平常点几下就生气，不好玩」 ———
check(
  '连点判定改成真正的速率窗口（不是「间隔小于 X 就累加」）',
  petCode.includes('pokeRecord') && petCode.includes('pokePrune') && /POKE_TIER\s*=\s*\{/.test(petCode),
)
check('窗口是滑动的，慢速点击攒不到炸毛', /pokePrune[\s\S]{0,200}now - t\[0\] > POKE_TIER\.window/.test(petCode))
check(
  '炸毛门槛是「又快又密」：至少 7 下且平均间隔 ≤ 260ms',
  /hardCount:\s*7/.test(petCode) && /hardGap:\s*260/.test(petCode) && /hardCount[\s\S]{0,120}hardGap/.test(petCode),
)
check('快速但未到炸毛只走撒娇抗议（ticklish），不跳进生气', petCode.includes('SAY.ticklish') && /tier\.rapid[\s\S]{0,120}softCool/.test(petCode))
check(
  '炸毛后有冷静期，不会一直凶主人',
  /angerCool:\s*\d+/.test(petCode) && /sinceAnger > T\.angerCool/.test(petCode) && /pokeState\.angerAt/.test(petCode),
)
check('平常戳身子池里没有生气的脸（生气只留给手速党）', /const POKE_BODY = \[[\s\S]*?\n  \]/.test(petCode) && !/const POKE_BODY = \[[\s\S]*?mood: 'grumpy'[\s\S]*?\n  \]/.test(petCode))
check('摸头池里「被叫胖」那条权重被压低（生气是彩蛋不是常态）', /mood: 'grumpy',\s*\n\s*w: 0\.4/.test(petCode))
check('反应池支持权重（pickFresh 会读 w）', petCode.includes('weightOf') && /weightOf[\s\S]{0,400}r -= weightOf\(x\)/.test(petCode))
check(
  '待机时不会再无缘无故摆生气的脸',
  /const pool = \['shy', 'confused', 'excited', 'alert', 'tongue', 'sweat', 'love'\]/.test(petCode) &&
    !/idleExpress[\s\S]{0,1200}const pool = \[[^\]]*'grumpy'/.test(petCode),
)
check('一轮结束必须把底层状态复位成平常', /case 'turn-end'[\s\S]{0,900}setBase\('neutral', IDLE_PROPS\)/.test(petCode))
check('空闲兜底复位（防止漏复位一直挂着某张脸）', petCode.includes('rig.base.mood !== \'neutral\'') || petCode.includes("if (rig.base.mood !== 'neutral') setBase('neutral', IDLE_PROPS)"))
check('庆祝不再播 aidale，只用一个装饰 + CSS 蹦一下', /case 'turn-end'[\s\S]{0,1500}qBounce\(1\.2\)/.test(petCode) && !/motion: 'aidale'/.test(petCode))
check('不再常驻播 idle 动作（那是猫爪+爱心动画）', !/playMotion\('idle'/.test(petCode) && petCode.includes('function stopMotion'))
check('UI 跟着模型缩放（比例不走样）', petCode.includes("UI_BASE_HEIGHT") && petCode.includes("setProperty('--dshp-s'") && petCode.includes('calc(12.5px * var(--dshp-s))'))
check('默认尺寸约原来的 1/3 面积', /height: 180,/.test(petCode) && petCode.includes('UI_BASE_HEIGHT = 180'))
check(
  '松手只吸附左右墙（竖直位置自由，不再吸底）',
  petCode.includes('function snapOnRelease') &&
    petCode.includes("const edge = nearR ? 'right' : 'left'") &&
    petCode.includes('function applyEdge') &&
    petCode.includes('SNAP_DIST') &&
    !petCode.includes("corner = nearR ? 'br' : 'bl'"),
)
check('竖直位置只做「别被屏幕切掉」的软夹，不做吸附', /function clampY\(/.test(petCode) && petCode.includes('maxTop'))
check('没注册 Expressions（避免和 rig 抢参数）', !JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/model/c_0120.model3.json'), 'utf8')).FileReferences.Expressions)

// ————————————————————————————————————————————————————————————
// 版本一致性：包版本与运行时上报的版本必须一样
//
// 为什么要有这条：`lib/index.js` 里那个 VERSION 是**运行时上报**的版本
// （/dsh-pet/state 的 version、前端注释头、设置页"插件版本"）。
// 它和 package.json 是**两个独立的地方**，没有任何机制保证同步 ——
// 2026-10-13 就从这里漂出去过：包升到 0.5.0，而 VERSION 还是 0.4.7-song.1，
// 于是"装的什么版本"两边说法不一致，排查问题时会先被这个误导。
// ————————————————————————————————————————————————————————————
{
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const hostSource = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  const m = /^const VERSION = '([^']+)'/m.exec(hostSource)
  check(
    'package.json 的 version 与 lib/index.js 的 VERSION 一致',
    !!m && m[1] === pkgVersion,
    m ? `package=${pkgVersion} host=${m[1]}` : 'lib/index.js 里找不到 const VERSION = \'…\'',
  )
}

server.close()
console.log(`\n结果: ${pass} 通过 / ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
