// ============================================================================
// test-media-local.mjs —— 本地音乐前端 media-local.js 的行为测试（不需要浏览器）
// ----------------------------------------------------------------------------
// 它在真机上不容易测：要真的点开音乐页、点播放、看 <audio> 有没有出声。所以这里用 vm 把它
// 抠出来跑，宿主那两条接口用桩替掉，直接断言它的判断：
//   · 歌单/设置怎么读、写接口回的整体载荷怎么吃进状态
//   · 播放/暂停/上下一首（含随机、循环 one）、按 id 重定位（导入删除后索引不再错位）
//   · 目录切换 / 删除 / 导入怎么发请求（payload 形状）
//   · 请求必须带 cookie（同源）—— 这是 /dsh-whale/* 过信任栅栏的前提，踩过一次
//   · 失败要说人话（没歌单、宿主 500、没有 fetch 的环境）
//
// 跑：node tools/test-media-local.mjs
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'assets', 'media-local.js')
const src = fs.readFileSync(SRC, 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  ok   ' + msg) }
  else { fail++; failures.push(msg); console.log('  FAIL ' + msg + (detail === undefined ? '' : '  → ' + detail)) }
}
const flush = () => new Promise((r) => setTimeout(r, 5))

/** 一个够用的假 <audio>（记下 src/play/pause 调用，可手动触发事件） */
function makeAudio() {
  const handlers = {}
  const a = {
    src: '', paused: true, volume: 1, loop: false,
    play() { this.paused = false; this.plays = (this.plays || 0) + 1; this.emit('play'); return Promise.resolve() },
    pause() { this.paused = true; this.pauses = (this.pauses || 0) + 1; this.emit('pause') },
    addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn) },
    emit(ev, arg) { for (const fn of handlers[ev] || []) fn(arg || {}) },
  }
  return a
}

function makeEnv(opts) {
  const o = opts || {}
  const calls = []
  const audios = []
  // ⚠️ 必须**每次请求时**才求值：写成 const tracks = ...() 会把"动态歌单"冻成快照，
  // 于是后面改 list 根本测不到（这个坑真实发生过：测的是桩不是模块）
  const listOf = () => (typeof o.tracks === 'function' ? o.tracks() : (o.tracks || []))
  const win = {
    Audio: function () { const a = makeAudio(); audios.push(a); return a },
    fetch: (url, init) => {
      calls.push({ url: String(url), init: init || null })
      if (o.noFetch) throw new Error('no fetch')
      const isPost = init && init.method === 'POST'
      if (isPost) {
        let body = null
        try { body = JSON.parse(init.body) } catch (err) {}
        const res = typeof o.postResult === 'function'
          ? o.postResult(body)
          : { ok: true, tracks: listOf(), managed: '/m', dir: '/m', custom: '', settings: { volume: 0.9, loop: 'all', shuffle: false } }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(res) })
      }
      if (o.failGet) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) })
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ok: true, tracks: listOf(), managed: '/managed', dir: o.dir || '/managed', custom: o.custom || '',
          settings: { volume: 0.5, loop: 'all', shuffle: !!o.shuffle, pressMode: true, autoplay: false },
        }),
      })
    },
  }
  const ctx = { window: win, console, Promise, Date, Math, JSON, String, encodeURIComponent, setTimeout }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  return { win, api: win.dshwSongLocal, calls, audios, tracks: listOf() }
}

const track = (id, name) => ({ id, name, title: name.replace(/\.[a-z0-9]+$/i, ''), ext: 'mp3', size: 100, inManaged: true, url: '/dsh-whale/music-file?id=' + id })
const postCalls = (calls) => calls.filter((c) => c.init && c.init.method === 'POST')

console.log('\n--- 装载与首次读取 ---')
{
  const env = makeEnv({ tracks: [track('a1', 'one.mp3'), track('b2', 'two.mp3')] })
  ok(!!env.api, '挂上了 window.dshwSongLocal', String(!!env.api))
  ok(env.calls.length === 1, '装载时立刻读一次歌单', JSON.stringify(env.calls.map((c) => c.url)))
  const init = env.calls[0].init
  ok(!!init && init.credentials === 'same-origin', '读歌单带同源凭据（信任栅栏要 cookie）', JSON.stringify(init))
  await flush()
  const st = env.api.state()
  ok(st.ok === true && st.tracks.length === 2, '状态里拿到歌单', JSON.stringify({ ok: st.ok, n: st.tracks.length }))
  ok(st.managed === '/managed' && st.dir === '/managed', '拿到托管目录与当前目录', st.managed + ' / ' + st.dir)
  ok(st.settings && st.settings.volume === 0.5, '拿到设置', JSON.stringify(st.settings))
}

console.log('\n--- 播放 / 暂停 / 上下一首 ---')
{
  const env = makeEnv({ tracks: [track('a1', 'one.mp3'), track('b2', 'two.mp3'), track('c3', 'three.mp3')] })
  await flush()
  const r = env.api.playId('b2')
  ok(r.ok === true && r.index === 1, 'playId(存在的 id) → 定位到第 2 首', JSON.stringify(r))
  const a = env.audios[0]
  ok(!!a && a.src === '/dsh-whale/music-file?id=b2', 'audio.src 指向 music-file?id=', a && a.src)
  ok(a.volume === 0.5, '播放时把设置里的音量用上（0.5）', String(a && a.volume))
  ok(env.api.state().playing === true, 'play 事件后状态是"在播"', String(env.api.state().playing))

  env.api.toggle()
  ok(a.paused === true && env.api.state().playing === false, '再点一次 → 暂停', 'paused=' + a.paused)
  env.api.toggle()
  ok(a.paused === false, '再点一次 → 继续播', 'paused=' + a.paused)

  env.api.next()
  ok(a.src === '/dsh-whale/music-file?id=c3', '下一首 → 第 3 首', a.src)
  env.api.next()
  ok(a.src === '/dsh-whale/music-file?id=a1', '下一首越界 → 回到第 1 首（循环）', a.src)
  env.api.prev()
  ok(a.src === '/dsh-whale/music-file?id=c3', '上一首越界 → 回到最后一首', a.src)

  // 播完自动下一首
  const before = a.src
  a.emit('ended')
  ok(a.src !== before, '一首放完 → 自动下一首', before + ' → ' + a.src)
  // 出错要说人话
  a.emit('error')
  ok(String(env.api.state().error).indexOf('放不出来') >= 0, '播放出错 → 状态里给一句人话', env.api.state().error)
}

console.log('\n--- 歌单为空 / 没有 Audio ---')
{
  const env = makeEnv({ tracks: [] })
  await flush()
  const r = env.api.playId()
  ok(r.ok === false && /歌单是空的/.test(r.error), '空歌单点播放 → 说清"歌单是空的"', JSON.stringify(r))
  ok(env.audios.length === 0, '空歌单不会创建 <audio>（不打扰页面）', String(env.audios.length))

  const env2 = makeEnv({ tracks: [track('a1', 'one.mp3')] })
  await flush()
  env2.win.Audio = undefined
  const r2 = env2.api.playId('a1')
  ok(r2.ok === false && /Audio/.test(r2.error), '环境没有 Audio → 明确报错', JSON.stringify(r2))
}

console.log('\n--- 索引重定位（导入/删除后不错位）---')
{
  let list = [track('a1', 'one.mp3'), track('b2', 'two.mp3'), track('c3', 'three.mp3')]
  const env = makeEnv({ tracks: () => list })
  await flush()
  env.api.playId('c3')
  ok(env.api.state().index === 2, '先放第 3 首', String(env.api.state().index))
  // 删掉第 1 首：原来的第 3 首变成第 2 个 —— 重新读歌单后索引要跟着走。
  // 用 refreshNow()：这首歌单**一定**要读最新（refresh 会复用同一个 tick 内在飞的请求）
  list = [track('b2', 'two.mp3'), track('c3', 'three.mp3')]
  await env.api.refreshNow()
  await flush()
  ok(env.api.state().tracks.length === 2, '歌单已更新为 2 首', String(env.api.state().tracks.length))
  ok(env.api.state().index === 1, '歌单变化后按 id 重新定位（c3 现在是第 2 个）', String(env.api.state().index))
  ok(env.api.state().currentId === 'c3', '当前曲目 id 不变', String(env.api.state().currentId))
}

console.log('\n--- 目录 / 删除 / 导入 的请求形状 ---')
{
  const env = makeEnv({ tracks: [track('a1', 'one.mp3')] })
  await flush()
  env.api.setDir('D:\\Music')
  env.api.setDir('')
  env.api.remove('a1')
  env.api.upload('x.mp3', 'data:audio/mpeg;base64,AAA')
  await flush()
  const posts = postCalls(env.calls).map((c) => JSON.parse(c.init.body))
  ok(posts.length === 4, '四个写操作各发一次 POST', JSON.stringify(posts))
  ok(posts[0].action === 'set-dir' && posts[0].dir === 'D:\\Music', 'setDir 传绝对路径', JSON.stringify(posts[0]))
  ok(posts[1].action === 'set-dir' && posts[1].dir === '', 'setDir("") = 回到托管目录', JSON.stringify(posts[1]))
  ok(posts[2].action === 'delete' && posts[2].id === 'a1', 'remove 传 id', JSON.stringify(posts[2]))
  ok(posts[3].action === 'upload' && posts[3].name === 'x.mp3' && posts[3].dataUrl.indexOf('data:audio/') === 0, 'upload 传 name + dataUrl', JSON.stringify(posts[3]))
  ok(postCalls(env.calls).every((c) => c.init.credentials === 'same-origin' && /application\/json/.test(c.init.headers['Content-Type'])),
    '写请求都带同源凭据 + JSON 头', JSON.stringify(postCalls(env.calls).map((c) => c.init.headers)))
}

console.log('\n--- 写接口回整体载荷时直接吃进状态（省一次请求）---')
{
  let list = [track('a1', 'one.mp3')]
  const env = makeEnv({
    tracks: () => list,
    postResult: (body) => {
      if (body && body.action === 'set-dir') {
        list = [track('a1', 'one.mp3'), track('z9', 'from-custom.mp3')]
        return { ok: true, tracks: list, managed: '/managed', dir: body.dir, custom: body.dir, settings: { volume: 0.9, loop: 'all', shuffle: false } }
      }
      return { ok: true, tracks: list, managed: '/managed', dir: '/managed', custom: '', settings: { volume: 0.9, loop: 'all', shuffle: false } }
    },
  })
  await flush()
  const before = env.calls.length
  await env.api.setDir('/custom')
  ok(env.calls.length === before + 1, 'setDir 只发一次请求（不用再读一遍歌单）', 'calls=' + (env.calls.length - before))
  ok(env.api.state().tracks.length === 2 && env.api.state().custom === '/custom', '写回的整体载荷已生效', JSON.stringify({ n: env.api.state().tracks.length, custom: env.api.state().custom }))
}

console.log('\n--- 失败路径 ---')
{
  const env = makeEnv({ failGet: true })
  await flush()   // 等首帧读完成（模块装载时就发了一次）
  ok(env.api.state().ok === false && env.api.state().error, '宿主 500 → ok:false 且状态里有原因', JSON.stringify(env.api.state().error))
  const env3 = makeEnv({ tracks: [] })
  env3.win.fetch = () => Promise.reject(new Error('boom'))
  await flush()
  await env3.api.refresh()
  await flush()
  ok(env3.api.state().ok === false && /boom/.test(String(env3.api.state().error)),
    '请求 reject → 不让它炸出去，状态里记原因', JSON.stringify(env3.api.state().error))
  // "没有 fetch 的环境"：装载时的首次读是正常的，**之后** fetch 消失（老壳/被拦），
  // 这时 refreshNow 应当安静地给出人话而不是抛出去
  const env4 = makeEnv({ tracks: [track('a1', 'one.mp3')] })
  await flush()
  env4.win.fetch = undefined
  await env4.api.refreshNow()
  await flush()
  ok(env4.api.state().ok === false && /fetch/.test(String(env4.api.state().error)),
    '没有 fetch 的环境（老壳）→ 不炸，状态里说清', JSON.stringify(env4.api.state().error))
}

console.log('\n--- 订阅：状态变化会通知 ---')
{
  const env = makeEnv({ tracks: [track('a1', 'one.mp3')] })
  await flush()
  let hits = 0
  const fn = () => { hits++ }
  env.api.on(fn)
  env.api.playId('a1')
  ok(hits >= 1, 'on() 订阅后播放会回调（音乐页据此重画）', 'hits=' + hits)
  env.api.off(fn)
  const before = hits
  env.api.toggle()
  ok(hits === before, 'off() 之后不再回调', 'hits=' + hits)
}

console.log('\n结果：pass ' + pass + ' / fail ' + fail)
if (fail && failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail ? 1 : 0)
