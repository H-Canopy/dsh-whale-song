// ============================================================================
// media-bridge.js —— 鲸歌（dsh-whale-song）的媒体桥：让她知道"挂件那边在放什么"
// ----------------------------------------------------------------------------
// 【依赖方向】本模块只**读**别人的状态，不要求对方知道我们存在：
//   ① 首选 window.dshwMediaNow()  —— 挂件 dsh-whale-widget 暴露的只读接口
//   ② 兜底 GET /dsh-whale/netease.json 的 nowPlaying（挂件宿主的路由，仅回环可用）
//   两者都没有 = 挂件没装或没在放 → 一声不响（不报错、不打扰、不刷屏）
//
// 【行为】只在状态发生变化时动一次：
//   开始/继续播放 → setUserFace('happy'|'listening') + report(头顶信封，曲名/歌手/音源)
//   暂停         → setUserFace('sleepy') + report(已暂停…)
//   切歌（播放中）→ 额外 playMotion('splash') 演一下
//   首次同步不演动作（避免刚打开页面就蹦）
//
// 【调试】window.dshwSongBridge = false 关闭；window.dshwSongBridgeTick() 手动触发一次
// ============================================================================
(function () {
  'use strict'

  var TICK_MS = 2000
  var lastKey = ''

  function petApi() {
    try {
      var p = window.DSHPet
      return (p && typeof p === 'object') ? p : null
    } catch (err) { return null }
  }

  function bridgeOff() {
    try { return window.dshwSongBridge === false } catch (err) { return false }
  }

  // 简报开关：她的"信箱/信封"是放**工作简报**的地方，我们每次切歌都塞一条会把那里搞乱
  //（实测：连着放几首就堆出未读计数，看起来像一堆碎片）。所以默认**不发**简报，
  // 需要时显式打开 window.dshwSongBridgeReports = true（后续做成设置页里的开关）。
  function reportsOn() {
    try { return window.dshwSongBridgeReports === true } catch (err) { return false }
  }

  // ① 挂件暴露的只读接口（同页面）
  function readGlobal() {
    try {
      var fn = window.dshwMediaNow
      if (typeof fn !== 'function') return null
      var r = fn()
      return (r && r.ok) ? r : null
    } catch (err) { return null }
  }

  // ② 兜底：挂件宿主的路由（挂件没暴露接口时用；没有挂件时 404/401，静默忽略）
  function readRoute(cb) {
    try {
      fetch('/dsh-whale/netease.json', { credentials: 'omit' })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (d) {
          var np = d && d.nowPlaying
          if (!np || !np.title) { cb(null); return }
          var st = np.status ? String(np.status) : ''
          cb({
            ok: true,
            source: 'netease',
            title: String(np.title),
            artist: np.artist ? String(np.artist) : '',
            detail: st,
            playing: st === 'Playing',
            body: '',
          })
        })
        .catch(function () { cb(null) })
    } catch (err) { cb(null) }
  }

  function sourceName(s) {
    if (s.source === 'radio') return '在线电台'
    if (s.source === 'netease') return '网易云'
    return '本地音乐'
  }

  function bodyOf(s) {
    var t = String(s.title || '') + (s.artist ? ' — ' + String(s.artist) : '')
    var verb = s.source === 'radio' ? '收听' : '播放'
    var line = (s.playing ? '正在' + verb + '：' : '已暂停：') + t
    var extra = s.detail ? '\n' + (s.source === 'radio' ? '正在播：' : '状态：') + String(s.detail) : ''
    return line + extra + '\n音源：' + sourceName(s)
  }

  function apply(s) {
    if (!s || !s.title) return
    var api = petApi()
    if (!api) return   // 她还没加载好：不记 key，等她出现时再补一次同步
    var key = [s.source, s.title, s.artist, s.playing ? '1' : '0', s.detail].join('|')
    if (key === lastKey) return
    var first = (lastKey === '')
    lastKey = key

    try {
      if (typeof api.setUserFace === 'function') {
        api.setUserFace(s.playing ? (s.source === 'radio' ? 'listening' : 'happy') : 'sleepy')
      }
    } catch (err) {}

    // 简报默认不发（见 reportsOn 的说明）：只换表情 + 演动作，不往她的信箱里塞东西。
    if (reportsOn()) {
      try {
        if (typeof api.report === 'function') {
          api.report('🐋 挂件 · ' + (s.playing ? '正在播放' : '已暂停'), s.body || bodyOf(s))
        }
      } catch (err) {}
    }

    if (!first && s.playing) {
      try { if (typeof api.playMotion === 'function') api.playMotion('splash') } catch (err) {}
    }
  }

  function tick() {
    if (bridgeOff()) return
    var g = readGlobal()
    if (g) { apply(g); return }
    readRoute(function (r) { if (r) apply(r) })
  }

  try { window.dshwSongBridgeTick = tick } catch (err) {}
  try {
    if (!window.dshwSongBridgeTimer) window.dshwSongBridgeTimer = setInterval(tick, TICK_MS)
  } catch (err) {}
  // 页面刚加载时若挂件已就绪，稍等一下就对一次（挂件那边可能还在初始化）
  try { setTimeout(tick, 1500) } catch (err) {}
})()
