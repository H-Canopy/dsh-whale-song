// ============================================================================
// media-bridge.mjs —— 系统媒体会话（SMTC）桥：**宿主与独立壳共用**的这一份
// ----------------------------------------------------------------------------
// 为什么单独抽出来：这套逻辑现在有两个调用方 ——
//   ① DSH 宿主（lib/index.js 的 /dsh-pet/media 路由）
//   ② 独立桌宠壳（desktop/standalone/server.mjs 的本地迷你服务）
// 两处各写一份必然漂移（一边修了白名单/缓存，另一边忘），所以只留这一个实现。
//
// 它做的事：调用 lib/smtc-helper.ps1（Windows PowerShell 5.1 + WinRT），把"系统里有哪些
// 媒体会话 / 当前在放什么 / 遥控"变成简单的 async 方法，并带一个短 TTL 缓存。
//
// 安全边界（两条调用方都必须自己保证）：
//   · **只允许固定命令白名单**（play/pause/toggle/next/prev），参数不透传；
//   · **app 过滤器只允许会话 id 形态的字符**（字母数字和 . _ - 空格 | : \ /），长度 ≤ 128；
//     不给用户"任意正则"入口（那才是能把正则引擎拖死的口子）。
//   · 默认（不带 app）**只认网易云** —— SMTC 是机器级共享的，默认收紧才安全。
//   · 调用方还要保证**只有本机（回环）能到达这条链路**。
// ============================================================================
'use strict'
// ⚠️ 本文件是**生成物**（由 lib/media-bridge.mjs 机械转换而来，见 tools 里的说明）。
// 别直接改它 —— 要改逻辑请改 lib/media-bridge.mjs，然后重新生成：
//   node D:\Bigfish\_staging\make-shell-cjs-bridge.mjs
const path = require('node:path')
const { spawn } = require('node:child_process')

/** 助手脚本与本文件同目录（lib/smtc-helper.ps1） */
const SMTC_HELPER = path.join(__dirname, '..', '..', 'lib', 'smtc-helper.ps1')

/** 允许的遥控命令；toggle 由本模块翻译成 play/pause（会话本身没有 toggle）。 */
const MEDIA_CMDS = ['play', 'pause', 'toggle', 'next', 'prev']
/** 过滤器白名单字符：会话 id 长这样（cloudmusic.exe / MSEdge / PotPlayerMini64.exe）。 */
const MEDIA_APP_RE = /^[A-Za-z0-9 ._|:\\/-]{1,128}$/

/** 把助手返回的短错误码翻成人话（界面上只显示这个，不显示 token）。 */
function mediaReason(code) {
  switch (code) {
    case 'no-session':
      return '没找到在放东西的播放器（它没在播，或者关了）'
    case 'control-failed':
      return '播放器拒绝了这次操作（比如没有下一首）'
    case 'smtc-unavailable':
      return '系统媒体会话读不到（需要 Windows PowerShell 5.1 / WinRT 可用）'
    case 'spawn-failed':
      return '起不了 Windows PowerShell（助手脚本或权限有问题）'
    case 'timeout':
      return '播放器响应太慢（助手超时被杀掉了）'
    case 'bad-json':
      return '媒体助手返回了看不懂的结果'
    case 'bad-app':
      return '播放器过滤器不合法'
    case 'bad-cmd':
      return '不支持这个遥控命令（只支持 ' + MEDIA_CMDS.join(' / ') + '）'
    default:
      return code ? String(code) : '未知错误'
  }
}

/**
 * SMTC 桥。
 * @param {object} [opts]
 * @param {string} [opts.helper] 助手脚本路径（默认 lib/smtc-helper.ps1）
 * @param {string} [opts.psExe]  PowerShell 可执行文件（默认 Windows PowerShell 5.1；测试可用 DSHW_PS_EXE 覆盖）
 * @param {number} [opts.nowTtlMs] "读当前曲目"的缓存（默认 1500ms）
 * @param {number} [opts.listTtlMs] "列会话"的缓存（默认 5000ms）
 */
function createMediaBridge(opts) {
  const o = opts || {}
  const helper = o.helper || SMTC_HELPER
  const psExe = o.psExe || process.env.DSHW_PS_EXE
    || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const nowTtlMs = typeof o.nowTtlMs === 'number' ? o.nowTtlMs : 1500
  const listTtlMs = typeof o.listTtlMs === 'number' ? o.listTtlMs : 5000
  const cache = new Map()

  /**
   * 调一次助手。**永远 resolve**，绝不 reject：失败也是同一个 {ok:false,error} 形状，
   * 调用方不必写 try/catch 分支。
   */
  function run(cmd, app, list) {
    return new Promise((resolve) => {
      // -NoProfile：别让用户 profile 里的输出污染 stdout（stdout 必须是"恰好一行 JSON"）
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Cmd', cmd]
      if (app) args.push('-App', app)
      if (list) args.push('-List')
      let child
      try {
        child = spawn(psExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        resolve({ ok: false, error: 'spawn-failed', detail: String((err && err.message) || err) })
        return
      }
      let out = ''
      let diag = ''
      let done = false
      const settle = (value) => {
        if (done) return
        done = true
        clearTimeout(killer)
        resolve(value)
      }
      // SMTC 实测 ~500ms；15 秒还没回来一定是卡住了，杀掉避免请求堆积
      const killer = setTimeout(() => {
        try { child.kill() } catch (err) {}
        settle({ ok: false, error: 'timeout', detail: diag.slice(-400) })
      }, 15000)
      child.stdout.on('data', (c) => { out += c.toString('utf8') })
      child.stderr.on('data', (c) => { diag += c.toString('utf8') })
      child.on('error', (err) => settle({ ok: false, error: 'spawn-failed', detail: String((err && err.message) || err) }))
      child.on('close', () => {
        const line = out.split(/\r?\n/).find((l) => l.trim().length > 0)
        if (!line) {
          settle({ ok: false, error: 'bad-json', detail: diag.slice(-400) })
          return
        }
        try {
          const parsed = JSON.parse(line)
          if (diag.trim() && parsed && typeof parsed === 'object') parsed.diag = diag.trim().slice(-400)
          settle(parsed)
        } catch (err) {
          settle({ ok: false, error: 'bad-json', detail: line.slice(0, 200) })
        }
      })
    })
  }

  /** 带短 TTL 缓存地读（只缓存**成功**的结果，失败立刻重试） */
  async function readCached(app, list, ttlMs) {
    const key = (list ? 'list|' : 'now|') + (app || '')
    const hit = cache.get(key)
    const at = Date.now()
    if (hit && at - hit.at < ttlMs) return hit.value
    const value = await run('get', app, list)
    if (value && value.ok) {
      cache.set(key, { at: at, value: value })
      if (cache.size > 16) cache.delete(cache.keys().next().value)
    }
    return value
  }

  return {
    /** 列出机器上所有媒体会话 */
    listSessions: () => readCached('', true, listTtlMs),
    /** 读某个过滤器下的当前曲目（app 为空 = 助手默认：只网易云） */
    readNow: (app) => readCached(app || '', false, nowTtlMs),
    /**
     * 遥控。`cmd` 必须在 MEDIA_CMDS 里；`toggle` 会先读一次状态再翻成 play/pause。
     * @returns {Promise<{ok:boolean, did?:string, requested?:string, appId?:string, error?:string, reason?:string}>}
     */
    async control(cmd, app) {
      const wanted = String(cmd || '')
      if (MEDIA_CMDS.indexOf(wanted) < 0) return { ok: false, error: 'bad-cmd', reason: mediaReason('bad-cmd') }
      const filter = app == null ? '' : String(app)
      if (filter && !MEDIA_APP_RE.test(filter)) return { ok: false, error: 'bad-app', reason: mediaReason('bad-app') }
      let actual = wanted
      if (wanted === 'toggle') {
        const r = await readCached(filter, false, nowTtlMs)
        if (!r.ok) return { ok: false, error: r.error, reason: mediaReason(r.error) }
        const np = r.nowPlaying
        if (!np) return { ok: false, error: 'no-session', reason: mediaReason('no-session') }
        actual = String(np.status) === 'Playing' ? 'pause' : 'play'
      }
      const r = await run(actual, filter)
      // 控制成功后缓存**整体**作废：否则界面在 TTL 内还会显示旧状态
      cache.clear()
      if (!r.ok) return { ok: false, error: r.error, reason: mediaReason(r.error) }
      return { ok: true, did: r.did || actual, requested: wanted, appId: r.appId || '', reason: '' }
    },
    /** 只读探测（排障用）：环境是否具备 SMTC 能力 */
    async probe() {
      const r = await run('get', '', true)
      return { ok: !!r.ok, helper: helper, psExe: psExe, sessions: (r && r.sessions) || [], error: r && r.error }
    },
    /** 清缓存（测试/排障用） */
    clearCache: () => cache.clear(),
  }
}

module.exports = { createMediaBridge, mediaReason, MEDIA_CMDS, MEDIA_APP_RE, SMTC_HELPER }
