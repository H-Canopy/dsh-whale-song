// ============================================================================
// sources/netease.mjs —— 网易云音乐适配器（点播层）
// ----------------------------------------------------------------------------
// 职责只有一个：**搜索 → 把播放交给官方客户端**。它不解码音频、不碰账号凭据、不读 cookie，
// 也不做"免费听 VIP"这类绕过（会员判定一律交给官方客户端自己）。
//
// 播放怎么走：官方客户端注册了 `orpheus://` 协议，形态是 `orpheus://<base64(JSON)>`，
// JSON 固定为 {type:'song'|'playlist', id:'<纯数字>', cmd:'play'}。适配器只**生成**这个 URL
// 并调系统协议处理器（rundll32 url.dll,FileProtocolHandler），等于用户自己点了一个链接。
//（`orpheus://song/<id>` 那种直觉写法实测不被客户端识别。）
//
// 从哪搬来的：这条链路本来在挂件 dsh-whale-widget 里（已真机验证），这里只换接口形状，
// 行为不变 —— 以后加 QQ 音乐就是"再插一个文件"，宿主和前端都不用改。
//
// 环境变量（排障用，都有默认值）：
//   DSHW_NETEASE_BASE  上游根，默认 https://music.163.com
//   DSHW_NETEASE_EXE   客户端可执行文件（launch 用），默认自动探测
// ============================================================================
import fs from 'node:fs'
import { spawn, execSync } from 'node:child_process'

const BASE = process.env.DSHW_NETEASE_BASE || 'https://music.163.com'
// 上游对 UA / Referer 敏感（缺了容易被拒），与真机 CLI 用的是同一组
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const TIMEOUT_MS = 8000
const SEARCH_DEFAULT_LIMIT = 20
const SEARCH_MAX_LIMIT = 50

export const manifest = {
  id: 'netease',
  label: '网易云音乐',
  version: '1.0.0',
  author: 'H-Canopy',
  license: 'MIT',
  // 点播层的能力：搜索要出网、播放要起进程/协议唤起、launch 要能启动客户端。
  // control / readState 不在这里声明 —— 遥控与读状态走统一层（SMTC），不需要适配器实现。
  capabilities: ['detect', 'search', 'play', 'launch'],
  platform: ['win32'],
}

/** 只接受纯数字 id：它会被拼进 orpheus 命令，任何别的字符都说明调用方有问题 */
function numericId(value) {
  const s = String(value === undefined || value === null ? '' : value).trim()
  return /^\d{1,20}$/.test(s) ? s : ''
}

function text(value, max) {
  return String(value === undefined || value === null ? '' : value).slice(0, max)
}

/** artists → `A/B`（与挂件前端的约定一致）；逐个限长再整体截断，防畸形上游 */
function artistsOf(raw) {
  const names = []
  for (const a of Array.isArray(raw) ? raw : []) {
    const name = text(a && a.name, 100).trim()
    if (name) names.push(name)
  }
  return names.join('/').slice(0, 200)
}

function limitOf(raw) {
  const n = Number(String(raw === undefined || raw === null ? '' : raw).trim())
  if (!isFinite(n) || n <= 0) return SEARCH_DEFAULT_LIMIT
  return Math.min(Math.floor(n), SEARCH_MAX_LIMIT)
}

/** 上游 JSON（免登录）。**不带**任何账号信息，只有关键词 + UA/Referer。 */
async function upstreamJson(pathname, params) {
  const target = new URL(BASE + pathname)
  for (const [k, v] of params) target.searchParams.set(k, String(v))
  const res = await fetch(target.toString(), {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': UA, Referer: BASE + '/', Accept: '*/*' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error('上游返回 HTTP ' + res.status)
  // 注意：上游这些接口的 Content-Type 是 text/plain 但 body 是 JSON（实测），别用头判 JSON
  const body = await res.text()
  try { return JSON.parse(body) } catch (err) { throw new Error('上游返回的不是 JSON') }
}

/** 客户端可执行文件：注册表里 orpheus 协议的处理器就是它自己；找不到再试常见路径 */
function cloudmusicExe() {
  if (process.env.DSHW_NETEASE_EXE) return process.env.DSHW_NETEASE_EXE
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const out = execSync(`reg query "${hive}\\SOFTWARE\\Classes\\orpheus\\shell\\open\\command" /ve`, { encoding: 'utf8', windowsHide: true })
      const m = /"([^"]+cloudmusic\.exe)"/i.exec(out) || /(\S+cloudmusic\.exe)/i.exec(out)
      if (m) return m[1]
    } catch (err) {}
  }
  for (const p of [
    'C:\\Program Files\\Netease\\CloudMusic\\cloudmusic.exe',
    'C:\\Program Files (x86)\\Netease\\CloudMusic\\cloudmusic.exe',
  ]) if (fs.existsSync(p)) return p
  return ''
}

/** 这台机器上有没有它：有客户端可执行文件就算有 */
export async function detect() {
  const exe = cloudmusicExe()
  if (exe) return { ok: true, detail: exe }
  return { ok: false, reason: '没找到网易云音乐客户端（没装？或用 DSHW_NETEASE_EXE 指定路径）' }
}

/** 搜索单曲 → {ok, items:[{id,title,artist,album,extra}]} */
export async function search(ctx, q, limit) {
  const query = String(q === undefined || q === null ? '' : q).trim()
  if (!query) return { ok: false, reason: '搜索词是空的' }
  const n = limitOf(limit)
  let data
  try {
    data = await upstreamJson('/api/search/get/web', [['s', query], ['type', '1'], ['limit', n]])
  } catch (err) {
    return { ok: false, reason: '搜索失败：' + String((err && err.message) || err) }
  }
  const songs = data && data.result && Array.isArray(data.result.songs) ? data.result.songs : null
  if (!songs) return { ok: false, reason: '上游返回的结构不对（可能被限流了，过一会儿再试）' }
  const items = []
  for (const song of songs) {
    if (!song || typeof song !== 'object') continue
    const id = numericId(song.id)
    if (!id) continue   // 没有 id 就点不了播，直接丢
    items.push({
      id,
      title: text(song.name, 200),
      artist: artistsOf(song.artists),
      album: text(song.album && song.album.name, 200),
      // fee：8=免费档，1=会员（多数只能试听），0=无版权/下架，4=需购买专辑
      extra: { duration: Number(song.duration) || 0, fee: Number(song.fee) || 0, cover: text(song.album && song.album.picUrl, 1000) },
    })
    if (items.length >= n) break
  }
  if (!items.length) return { ok: false, reason: '没搜到可播放的结果' }
  return { ok: true, items }
}

/** 生成官方客户端的播放链接（不自己播、不解码） */
export function playUrl(item) {
  const id = numericId(item && (item.id || item.songId))
  if (!id) return ''
  const kind = (item && item.kind === 'playlist') ? 'playlist' : 'song'
  const command = { type: kind, id, cmd: 'play' }
  return 'orpheus://' + Buffer.from(JSON.stringify(command), 'utf8').toString('base64')
}

/** 把链接交给系统协议处理器（等于用户自己点了一下这个链接） */
function shellOpen(url) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    try {
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore', detached: true })
      child.on('spawn', () => { try { child.unref() } catch (err) {} done({ ok: true }) })
      child.on('error', () => done({ ok: false, reason: '系统没能打开这个链接（orpheus:// 协议没注册？）' }))
      // 只需要"交出去"：spawn 事件万一不来也别卡住调用方
      const t = setTimeout(() => done({ ok: true }), 4000)
      if (t && typeof t.unref === 'function') t.unref()
    } catch (err) {
      done({ ok: false, reason: '起不了系统协议处理器：' + String((err && err.message) || err) })
    }
  })
}

/** 点播：只生成链接并交给系统，播放与会员判定都由官方客户端负责 */
export async function play(ctx, item) {
  const url = playUrl(item)
  if (!url) return { ok: false, reason: '这条结果没有可用的歌曲 id' }
  const r = await shellOpen(url)
  if (!r.ok) return { ok: false, reason: r.reason, url }
  return { ok: true, url }
}

/** 没在跑就启动它。**不带任何参数** —— 尤其不加调试端口那种把已登录会话暴露出去的开关 */
export async function launch() {
  const exe = cloudmusicExe()
  if (!exe) return { ok: false, reason: '没找到网易云音乐客户端' }
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore' })
      child.on('spawn', () => { try { child.unref() } catch (err) {} done({ ok: true }) })
      child.on('error', () => done({ ok: false, reason: '启动客户端失败' }))
      const t = setTimeout(() => done({ ok: true }), 4000)
      if (t && typeof t.unref === 'function') t.unref()
    } catch (err) {
      done({ ok: false, reason: '启动客户端失败：' + String((err && err.message) || err) })
    }
  })
}
