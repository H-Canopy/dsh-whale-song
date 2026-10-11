// ============================================================================
// media-local.js —— 鲸歌（dsh-whale-song）本地音乐前端
// ----------------------------------------------------------------------------
// 【它管什么】宿主那套本地音乐服务（/dsh-whale/music.json + /dsh-whale/music-file，E1 从挂件
// 搬过来的）在前端的唯一入口：
//   · 读歌单（托管目录 $DSH_HOME/whale-music ∪ 自定义目录）与设置（音量/循环/随机/点按模式）
//   · 用页内 <audio> 播放/暂停/上下一首，支持进度 seek（宿主实现了 Range，所以 seek 真的能用）
//   · 设置自定义目录（把你自己的音乐库扫进来）、导入/删除托管目录里的曲目
//
// 【为什么不复用挂件的 widget.js】那是 18794 行的完整挂件 UI（含余额/角色/气泡……）。我们只需要
// 播放器这一小块，塞进音乐页才符合"她自己的界面"这条线，也才谈得上让挂件退休。
//
// 【与统一层的关系】本地音乐与"系统媒体会话（SMTC）"是两条路：
//   本地音乐是我们自己在页面里播（浏览器标签页的音频），SMTC 读的是 Windows 上别的播放器。
//   两者互不干扰；媒体桥只跟 SMTC 走（本地播放想让桌宠有反应，见 media-local 的 onstate 回调）。
//
// 【调试】window.dshwSongLocal.state()     当前状态（歌单/在放哪首/是否在播）
//          window.dshwSongLocal.refresh()   重新读歌单
//          window.dshwSongLocal.playId(id)  指定曲目播放
// ============================================================================
(function () {
  'use strict'

  var ROUTE = '/dsh-whale/music.json'
  var FILE_ROUTE = '/dsh-whale/music-file'
  var DEFAULT_VOLUME = 0.9

  var state = {
    ok: false,
    tracks: [],
    managed: '',
    dir: '',
    custom: '',
    settings: null,
    index: -1,
    playing: false,
    error: '',
  }
  var audio = null
  var listeners = []
  var loading = null

  function apiFetch(url, init) {
    try {
      if (typeof window.fetch !== 'function') return null
      // 同源请求必须带 cookie：/dsh-whale/* 过 DSH 信任栅栏（与 media-smtc 同一个坑）
      return window.fetch(url, init || { credentials: 'same-origin' })
    } catch (err) { return null }
  }

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state) } catch (err) {}
    }
  }

  /** 懒建 <audio>：只在真的要放音乐时才创建（不打扰页面） */
  function ensureAudio() {
    if (audio) return audio
    try {
      audio = new window.Audio()
      audio.preload = 'metadata'
      // 宿主 music-file 实现了 Range，所以拖动进度条是真的 seek（不是重新下载整首）
      audio.addEventListener('play', function () { state.playing = true; emit() })
      audio.addEventListener('pause', function () { state.playing = false; emit() })
      audio.addEventListener('ended', function () { next() })
      audio.addEventListener('error', function () {
        state.error = '这首歌放不出来（文件可能已删除或格式不支持）'
        state.playing = false
        emit()
      })
    } catch (err) { audio = null }
    return audio
  }

  function applySettings(s) {
    state.settings = s || null
    if (audio && s && typeof s.volume === 'number') {
      try { audio.volume = Math.max(0, Math.min(1, s.volume)) } catch (err) {}
    }
    if (audio) {
      try { audio.loop = !!(s && s.loop === 'one') } catch (err) {}
    }
  }

  function applyPayload(d) {
    if (!d || d.ok !== true) {
      state.ok = false
      state.error = (d && (d.error || d.reason)) || '读不到本地音乐'
      emit()
      return state
    }
    state.ok = true
    state.error = ''
    state.tracks = d.tracks || []
    state.managed = d.managed || ''
    state.dir = d.dir || ''
    state.custom = d.custom || ''
    applySettings(d.settings)
    // 歌单变了之后，把"正在放的那首"按 id 重新定位（导入/删除后索引会错位）
    if (state.currentId) {
      var idx = -1
      for (var i = 0; i < state.tracks.length; i++) if (state.tracks[i].id === state.currentId) idx = i
      state.index = idx
    }
    emit()
    return state
  }

  /**
   * 读歌单 + 设置。
   * **不复用**在飞的 promise：早期版本在"已有请求在飞"时直接返回那个 promise，结果并发/连续
   * 调用会拿到**旧结果**（实测：导入/删除后调 refresh 拿不到新歌单）。
   * 现在：`refresh()` 永远发新请求；同一个 tick 内的重复调用由 loading 合并成一次。
   * 需要"确定拿到最新"的场合（导入/删除后）用 refreshNow()。
   */
  function refresh() {
    // 同一个 tick 内已有请求在飞 → 复用（此时状态在它 settle 时一定会更新）
    if (loading) return loading
    var p = apiFetch(ROUTE)
    if (!p || typeof p.then !== 'function') {
      // 没 fetch 也要把 ok 置假：只写 error 会让界面同时显示"上次的歌单"和一句错误
      state.ok = false
      state.error = '这个环境没有 fetch（老壳？）'
      emit()
      return Promise.resolve(state)
    }
    loading = p
      .then(function (r) { return r && r.ok ? r.json() : null })
      .then(function (d) { return applyPayload(d) })
      .catch(function (err) {
        state.ok = false
        state.error = String((err && err.message) || err)
        emit()
        return state
      })
      .then(function (v) { loading = null; return v })
    return loading
  }
  /** 明确要最新数据（导入/删除/切换目录之后） */
  function refreshNow() {
    loading = null
    return refresh()
  }

  /** 写接口（宿主的 POST：set-settings / set-dir / upload / delete） */
  function post(payload) {
    var p = apiFetch(ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    })
    if (!p || typeof p.then !== 'function') return Promise.resolve({ ok: false, error: 'no-fetch' })
    return p.then(function (r) { return r.json() }).then(function (d) {
      // 写成功时宿主回的就是**整个** music.json 载荷，直接用它刷新本地状态（省一次请求）
      if (d && d.ok === true && d.tracks) return applyPayload(d)
      if (d && d.ok === false) { state.error = d.error || '写入失败'; emit() }
      return d
    }).catch(function (err) {
      state.error = String((err && err.message) || err)
      emit()
      return { ok: false, error: state.error }
    })
  }

  function indexOfId(id) {
    for (var i = 0; i < state.tracks.length; i++) if (state.tracks[i].id === id) return i
    return -1
  }

  /** 播放指定曲目（默认当前索引；没有就从头开始） */
  function playId(id) {
    var idx = id ? indexOfId(id) : state.index
    if (idx < 0 && state.tracks.length) idx = 0
    var track = state.tracks[idx]
    if (!track) return { ok: false, error: '歌单是空的（先去设置里选一个音乐文件夹，或导入文件）' }
    var a = ensureAudio()
    if (!a) return { ok: false, error: '这个环境没有 Audio' }
    state.index = idx
    state.currentId = track.id
    state.error = ''
    applySettings(state.settings)
    try {
      a.src = FILE_ROUTE + '?id=' + encodeURIComponent(track.id)
      var pr = a.play()
      if (pr && typeof pr.catch === 'function') {
        pr.catch(function (err) {
          // 浏览器要求"用户手势后才能播"：点按钮进来的不会触发；自动播放会
          state.error = '浏览器拦住了自动播放，点一下播放键就行'
          emit()
        })
      }
    } catch (err) {
      state.error = String((err && err.message) || err)
      return { ok: false, error: state.error }
    }
    emit()
    return { ok: true, track: track, index: idx }
  }

  function toggle() {
    var a = ensureAudio()
    if (!a) return { ok: false, error: '这个环境没有 Audio' }
    if (!state.currentId && state.tracks.length) return playId()
    if (a.paused) {
      try { a.play() } catch (err) { return { ok: false, error: String(err && err.message) } }
    } else {
      try { a.pause() } catch (err) {}
    }
    return { ok: true }
  }

  function step(delta) {
    if (!state.tracks.length) return { ok: false, error: '歌单是空的' }
    var n = state.tracks.length
    var idx = state.index
    if (idx < 0) idx = 0
    else idx = (idx + delta + n) % n
    if (state.settings && state.settings.shuffle && delta > 0 && n > 1) {
      var pick = idx
      while (pick === idx) pick = Math.floor(Math.random() * n)
      idx = pick
    }
    return playId(state.tracks[idx].id)
  }
  function next() { return step(1) }
  function prev() { return step(-1) }

  function pause() {
    if (audio) { try { audio.pause() } catch (err) {} }
  }

  /** 设置：只发改动的键（宿主那边是合并写入） */
  function setSettings(patch) {
    return post({ action: 'set-settings', settings: patch || {} })
  }
  /** 选自定义目录（'' = 回到托管目录） */
  function setDir(dir) {
    return post({ action: 'set-dir', dir: String(dir == null ? '' : dir) })
  }
  function remove(id) {
    return post({ action: 'delete', id: String(id || '') })
  }
  function upload(name, dataUrl) {
    return post({ action: 'upload', name: String(name || ''), dataUrl: String(dataUrl || '') })
  }

  var api = {
    state: function () { return state },
    refresh: refresh,
    refreshNow: refreshNow,
    playId: playId,
    toggle: toggle,
    next: next,
    prev: prev,
    pause: pause,
    setSettings: setSettings,
    setDir: setDir,
    remove: remove,
    upload: upload,
    audio: function () { return audio },
    on: function (fn) { if (typeof fn === 'function') listeners.push(fn) },
    off: function (fn) { listeners = listeners.filter(function (f) { return f !== fn }) },
  }
  try { window.dshwSongLocal = api } catch (err) {}
  // 页面加载后先读一次（音乐页打开时就有歌单可看）
  try { refresh() } catch (err) {}
})()
