// ============================================================================
// media-smtc.js —— 鲸歌（dsh-whale-song）「统一层」前端：直接读系统媒体会话
// ----------------------------------------------------------------------------
// 【为什么需要它】原来"她知道在放什么"完全依赖挂件（dsh-whale-widget）暴露的
// window.dshwMediaNow()。没装挂件 = 一片空白。而 Windows 自己有一份机器级的媒体会话表
//（网易云 / QQ音乐 / 酷狗 / Spotify / foobar2000 / PotPlayer / VLC / 浏览器…），
// 宿主 lib/index.js 已经把这份表挂在回环路由 /dsh-pet/media 上（见 smtc-helper.ps1）。
// 于是：**不装挂件也能用**。
//
// 【分工】本文件只管"读 + 列播放器 + 记住你选了哪个 + 转发控制命令"。
// “读到之后要换什么表情”仍归 media-bridge.js —— 那边只多问一句 window.dshwSongSMTC.now()。
//
// 【隐私/打扰】默认开，但**不主动改任何播放状态**：只有你点音乐页的按钮才会发 POST。
// 设置里可整块关掉（CFG.songSystemMedia = false ⇒ 一次请求都不发）。
//
// 【凭据】宿主的路由都过 DSH 的信任栅栏（认 DSH 的会话 cookie，或桌面版的通行证 cookie），
// 所以这几个 fetch **不能**写 credentials:'omit' —— 那等于每次都不带票，栅栏一律 401，
// 结果就是"检测到 0 个播放器"。用默认的 same-origin（同源带 cookie）就对了。
// 这不是跨站请求：全部指向当前页面的同源 /dsh-pet/*。
//
// 【调试】window.dshwSongSMTC.now()      立刻读一次（返回 null = 没有/没开/读不到）
//          window.dshwSongSMTC.players() 列出所有媒体会话
//          window.dshwSongSMTC.pick(app) 固定跟随某个播放器（'' = 跟随系统自动）
//          window.dshwSongSMTC.tick()    强制刷新缓存
// ============================================================================
(function () {
  'use strict'

  var ROUTE = '/dsh-pet/media'
  var POLL_MS = 3000
  var TTL_MS = 2000

  function petPrefs() {
    try {
      return (typeof window.dshwSongPrefs === 'function') ? window.dshwSongPrefs() : null
    } catch (err) { return null }
  }

  // 设置里关掉就完全安静：一次请求都不发（也不去读用户的媒体会话）
  function enabled() {
    var p = petPrefs()
    if (p && p.systemMedia === false) return false
    try { if (window.dshwSongSystemMedia === false) return false } catch (err) {}
    return true
  }

  function apiFetch(url, init) {
    try {
      if (typeof window.fetch !== 'function') return null
      return window.fetch(url, init || { credentials: 'omit' })
    } catch (err) { return null }
  }

  // —— AppId → 人话名字 ——
  // 规则表只用来"好看"：命中不了就用 AppId 去掉 .exe 当名字，绝不假装认识。
  var NAMES = [
    [/cloudmusic/i, '网易云音乐'],
    [/QQMusic|QQMusicExternal/i, 'QQ音乐'],
    [/kugou/i, '酷狗音乐'],
    [/Kuwo|kwmusic/i, '酷我音乐'],
    [/Migumusic|migu/i, '咪咕音乐'],
    [/Spotify/i, 'Spotify'],
    [/foobar/i, 'foobar2000'],
    [/PotPlayer/i, 'PotPlayer'],
    [/vlc/i, 'VLC'],
    [/wmplayer/i, 'Windows Media Player'],
    [/GrooveMusic|ZuneMusic/i, 'Groove 音乐'],
    [/MSEdge|msedge/i, 'Edge'],
    [/chrome/i, 'Chrome'],
    [/firefox/i, 'Firefox'],
    [/AIMP/i, 'AIMP'],
  ]
  function prettyName(appId) {
    var id = String(appId || '')
    for (var i = 0; i < NAMES.length; i++) if (NAMES[i][0].test(id)) return NAMES[i][1]
    return id.replace(/\.exe$/i, '') || '未知播放器'
  }

  // 用户固定的播放器（'' = 跟随系统：谁在放谁算数）。存 localStorage，和她的 CFG 各自独立。
  var PICK_KEY = 'dshwSongPlayer'
  function picked() {
    try { return String(window.localStorage.getItem(PICK_KEY) || '') } catch (err) { return picked.fallback || '' }
  }
  function setPicked(app) {
    var v = String(app || '')
    picked.fallback = v
    try { window.localStorage.setItem(PICK_KEY, v) } catch (err) {}
    cache = null
    return v
  }

  var cache = null     // { at, players, current }
  var inflight = null  // 正在进行的读（多处同时调用只发一次请求）

  function normPlayer(row) {
    var st = String((row && row.status) || '')
    return {
      app: String((row && row.appId) || ''),
      name: prettyName(row && row.appId),
      title: String((row && row.title) || ''),
      artist: String((row && row.artist) || ''),
      status: st,
      playing: st === 'Playing',
    }
  }

  /** 从会话列表里挑"当前生效"的那一个：先找正在播的，否则找有曲目的。 */
  function currentOf(players) {
    var pin = picked()
    if (pin) {
      for (var i = 0; i < players.length; i++) if (players[i].app === pin) return players[i]
      // 固定的那个已经不在会话里了：退回自动，但**不改**用户的选择（他可能只是关了一会）
      return null
    }
    for (var j = 0; j < players.length; j++) if (players[j].playing) return players[j]
    for (var k = 0; k < players.length; k++) if (players[k].title) return players[k]
    return null
  }

  function apply(players) {
    cache = { at: Date.now(), players: players, current: currentOf(players) }
    return cache
  }

  /** 读会话列表（带 2 秒缓存；同一页多处调用不会各发一次请求） */
  function load(force) {
    return new Promise(function (resolve) {
      if (!enabled()) { resolve(null); return }
      if (!force && cache && (Date.now() - cache.at) < TTL_MS) { resolve(cache); return }
      // 已经有一次在飞就别再发一条：页面刚加载时"轮询 + 音乐页 + 媒体桥"可能同时问
      if (inflight) { inflight.then(resolve); return }
      // 同源请求，**必须**带 cookie（信任栅栏认 DSH 会话 / 桌面版通行证）
      var p = apiFetch(ROUTE + '?list=1', { credentials: 'same-origin' })
      if (!p || typeof p.then !== 'function') { resolve(null); return }
      inflight = p.then(function (r) { return r && r.ok ? r.json() : null })
        .then(function (d) {
          if (!d || !d.ok || !d.sessions) return cache
          return apply(d.sessions.map(normPlayer))
        })
        .catch(function () { return cache })
      inflight.then(function (v) { inflight = null; resolve(v) })
    })
  }

  /**
   * 当前在放什么 —— 给 media-bridge 用的统一形状（和挂件的 dshwMediaNow() 对齐）。
   * 返回 null = 没在放 / 关掉了 / 读不到（调用方据此静默）。
   */
  function now() {
    if (!enabled()) return null
    if (!cache) return null          // 首次读由下面的预取负责，本次先安静
    if ((Date.now() - cache.at) > 6000) load()   // 后台续上，避免停顿太久
    var c = cache.current
    if (!c || !c.title) return null
    return {
      ok: true,
      source: 'system',
      app: c.app,
      player: c.name,
      title: c.title,
      artist: c.artist,
      detail: c.status,
      playing: c.playing,
      body: '',
    }
  }

  /** 控制命令：作用于"当前生效播放器"（或固定选中的那个）。 */
  function control(cmd) {
    if (!enabled()) return Promise.resolve({ ok: false, error: 'disabled', reason: '设置里关掉了系统媒体读取' })
    var body = { cmd: String(cmd || '') }
    var pin = picked()
    if (pin) body.app = pin
    var p = apiFetch(ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!p || typeof p.then !== 'function') return Promise.resolve({ ok: false, error: 'no-fetch', reason: '这个环境没有 fetch' })
    cache = null   // 控制完立刻作废本地缓存，下一次读拿到新状态
    return p.then(function (r) { return r.json() }).catch(function (err) {
      return { ok: false, error: 'request-failed', reason: String((err && err.message) || err) }
    })
  }

  function tick() { if (enabled()) load(true); }

  var api = {
    now: now,
    players: function () { return cache ? cache.players.slice() : [] },
    current: function () { return cache ? cache.current : null },
    pick: setPicked,
    picked: picked,
    control: control,
    load: load,
    ready: function () { return !!cache },
    tick: tick,
    prettyName: prettyName,
    enabled: enabled,
  }
  try { window.dshwSongSMTC = api } catch (err) {}
  try {
    if (!window.dshwSongSMTCTimer) window.dshwSongSMTCTimer = setInterval(tick, POLL_MS)
  } catch (err) {}
  // 立刻先读一次（不等轮询那 3 秒）：音乐页刚打开时"检测到 0 个播放器"会让人以为坏了
  try { load(true) } catch (err) {}
})()
