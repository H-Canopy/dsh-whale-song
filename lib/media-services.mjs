// ============================================================================
// media-services.mjs —— 本地音乐服务 + 在线电台代理（鲸歌 dsh-whale-song 增量）
// ----------------------------------------------------------------------------
// 【这份代码是从哪来的】原样搬自鲸鱼挂件 dsh-whale-widget 的 lib/index.js（MIT，H-Canopy
// 自己的 fork 增量），只做了三处必要改动：
//   ① 去掉外层缩进、包成 registerMediaServices(ctx) 一个函数（挂件那边是在
//      root.inject([...], (ctx) => { ... }) 回调里的同一段代码）；
//   ② 模块头补上 dns / createHash 两个 import；
//   ③ 导入我们自己的 DSH_HOME（状态文件与托管目录都落在 $DSH_HOME 下）；
//   ④ 信任栅栏支持"宿主优先"：传了 opts.rejected 就用宿主的，否则用搬过来的这份。
//
// 【为什么搬】挂件那套"本地音乐 + 在线电台"的**宿主端**是它自己的播放能力；鲸歌要能独立
// 放本地音乐与电台，就必须自己拥有这几条路由 —— 搬完挂件才可以退休（依赖方向反转：
// 桌宠不再读挂件，两边各自完整）。
//
// 【路由路径为什么还是 /dsh-whale/*】那两套验收 harness（whale-widget-patch-tests 下的
// music-harness.mjs / radio-harness.mjs）就是按这个路径写死的，它是这次搬迁的**验收标准**；
// 沿用同一路径同时也让挂件的旧客户端在过渡期还能用。
//
// 【安全边界（搬过来之后依然成立）】
//   · 所有路由都过 rejected() 信任栅栏 + 写请求额外过 writeRejection()；
//   · radio-search / radio-stream 只认回环（它们会代表宿主的网络身份出网）；
//   · radio-stream 有完整 SSRF 防护：协议白名单、拒用户名密码、拒回环/私网/链路本地/保留段、
//     逐跳重查、跳数上限、体积与超时上限、Content-Type 白名单、.pls/.m3u 解引用（深度上限 2）。
//
// 【状态文件】$DSH_HOME/.dshw-music.json、$DSH_HOME/.dshw-radio.json（与挂件共用同一份，
// 所以换插件不会丢歌单/收藏）。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dns from 'node:dns'
import { createHash } from 'node:crypto'

// Node 的 fetch(undici) 可能优先 IPv6：个别域名有 AAAA 记录但本机 IPv6 不通会直接 "fetch failed"
//（curl 会自动回退 IPv4）。统一改 IPv4 优先 —— 与挂件同一处理。
try { dns.setDefaultResultOrder('ipv4first') } catch (err) {}

/** 状态文件与托管目录的根：与宿主同一个 DSH_HOME（可用环境变量覆盖，测试就是这么隔离的） */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/**
 * 把本地音乐服务与在线电台代理挂到宿主上。
 * @param {object} ctx 宿主插件上下文（要能 webServer.register / get('connection')）
 * @param {object} [opts]
 * @param {Function} [opts.rejected] 宿主自己的信任栅栏（有就用它，语义以宿主为准）
 * @param {Function} [opts.register] 宿主的注册器 (kind, path, handler) => disposer；
 *        给了它就用它（宿主那层的 route() 已经套过信任栅栏并负责卸载）
 * @returns {object} { routes: string[] } 实际注册的路由清单（便于宿主自检/日志）
 */
export function registerMediaServices(ctx, opts) {
  const hostRejected = opts && typeof opts.rejected === 'function' ? opts.rejected : null
  const register = opts && typeof opts.register === 'function'
    ? opts.register
    : (kind, pathname, handler) => ctx.webServer.register({ kind, path: pathname, handler })
  const registered = []
  /**
   * 注册一条路由。
   * ⚠️ **栅栏在这里由模块自己套**（不是交给宿主的 route()）：
   * 这几条路由带着写接口与 SSRF 边界，安全边界不能外包给调用方 —— 曾经只转发给宿主，
   * 结果一旦换个注册器（测试、别的宿主）栅栏就静默消失了。宿主那层若也套一层，
   * 允许路径上两次都返回 false（只重算一遍，无副作用），拒绝路径上宿主的包装会先返回，
   * 不会出现"往已结束的 res 再写一次"。
   */
  const registerVia = (kind, pathname, handler) => {
    registered.push(pathname)
    const guarded = async (req, res) => {
      if (rejected(req, res)) return
      return handler(req, res)
    }
    return register(kind, pathname, guarded)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 音乐常量（托管目录/状态文件/扩展名/MIME/上限）（原样搬自挂件 lib/index.js 57-104）
  // ═══════════════════════════════════════════════════════════════════════
// —— 音乐播放器：托管目录 $DSH_HOME/whale-music/ + 状态文件 $DSH_HOME/.dshw-music.json ——
// 为什么和 whale-audio/（音效库）分成两套：音效是"插件自己导入的片段"，要维护 audio.json 索引；
// 音乐是"用户自己丢进来的歌"，插件**只读不写、不建索引** —— 用户用资源管理器往目录里拷歌，
// 下一次扫描就出现，不需要经过插件的导入流程（也因此不需要"清理空索引"这种维护动作）。
// 候选表只放 $DSH_HOME（含 profiles/web 兜底）：DATA_CANDIDATES_TAIL 是空的，拼出来的
// "undefinedwhale-music/" 是相对路径，mkdirSync 会在宿主工作目录里建出一个垃圾目录。
const MUSIC_DIR_CANDIDATES = [
  path.join(DSH_HOME, 'whale-music'),
  path.join(DSH_HOME, 'profiles', 'web', 'whale-music'),
]
const MUSIC_STATE_NAME = '.dshw-music.json'
const MUSIC_FILE_CANDIDATES = [
  path.join(DSH_HOME, MUSIC_STATE_NAME),
  path.join(DSH_HOME, 'profiles', 'web', MUSIC_STATE_NAME),
]
// 扫描与上传共用的扩展名白名单（一律小写比较）：少写一个都表现为"歌单里少了文件"，
// 所以只留这一张表，扫描、上传校验、music.json 的 supported 字段全从它取。
const MUSIC_EXTS = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac']
// 扩展名 → Content-Type（music-file 按它下发）。MIME 与字节不符会让浏览器解码路径异常。
const MUSIC_MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
}
// dataURL 的 mime 子类型 → 扩展名：上传时 name 的后缀优先，后缀不在白名单才按它推断。
// 这张表同时就是"允许上传的 mime 白名单"（键之外的 mime 一律 400）。
const MUSIC_EXT_BY_MIME = {
  mpeg: 'mp3', mp3: 'mp3',
  mp4: 'm4a', m4a: 'm4a', 'x-m4a': 'm4a',
  aac: 'aac',
  ogg: 'ogg', opus: 'ogg',
  wav: 'wav', 'x-wav': 'wav', wave: 'wav',
  flac: 'flac', 'x-flac': 'flac',
}
// 单文件**解码后**上限。为什么是 48MB 而不是 64MB：
//   上传体是 base64 的 dataURL（`data:audio/…;base64,<…>`），相对原始字节膨胀 4/3 ≈ 1.33 倍，
//   而 music.json 的 body 上限是 64MB ⇒ 64MB 的 body 最多只能装 64 ÷ 1.33 ≈ 48MB 音频。
//   所以"解码后 ≤ 64MB"这条判断**永远走不到**（body 会先被 readBodyMax 以 body too large 拒掉），
//   名义上限大于可达上限会让人以为"64MB 以内都能传" ⇒ 直接把**真正可达**的值写成常量。
//   ⚠️ 改这里必须同步改 body 上限（music.json 里的 readBodyMax 64MB）：两者要满足
//      body 上限 ≥ MUSIC_MAX_BYTES × 4/3 才自洽（48 × 1.33 = 64）。
const MUSIC_MAX_BYTES = 48 * 1024 * 1024
// 上传超限的提示文案：数字从常量算，避免"改了上限忘了改文案"（前端直接把这句话显示给用户）
const MUSIC_MAX_MB = Math.round(MUSIC_MAX_BYTES / 1024 / 1024)

  // ═══════════════════════════════════════════════════════════════════════
  // JSON 响应头（原样搬自挂件 lib/index.js 974-978）
  // ═══════════════════════════════════════════════════════════════════════
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}

  // ═══════════════════════════════════════════════════════════════════════
  // 电台常量 + SSRF 防护 + 播放列表解析（原样搬自挂件 lib/index.js 106-377）
  // ═══════════════════════════════════════════════════════════════════════
// —— 在线电台（Radio Browser / SomaFM）——
// 上游环境变量（进程启动时读一次即固定；**离线端到端验证就是靠把上游指向本地桩服务器**）：
//   · DSHW_RADIO_BROWSER_BASE：显式指定 Radio Browser 的 API 根（**优先**用；默认见下面镜像表）
//   · DSHW_RADIO_BROWSER_MIRRORS：镜像候选表（逗号分隔），默认 de1,all,api —— 见下面的实测注释
//   · DSHW_SOMAFM_URL：SomaFM 频道表 JSON 的完整地址，默认 https://somafm.com/channels.json
//   · DSHW_RADIO_UA：请求上游时带的 User-Agent，默认带项目主页（Radio Browser **明确要求**带一个
//     可识别的 UA；空 UA / 通用脚本 UA 会被它限流甚至直接拒绝，表现为"搜索永远 502"）
//   · DSHW_RADIO_ALLOW_HOSTS：SSRF 防护的窄口径逃生口（语义见它自己的注释）
const RADIO_BROWSER_EXPLICIT = String(process.env.DSHW_RADIO_BROWSER_BASE || '').trim().replace(/\/+$/, '')
// Radio Browser 的镜像表：**默认必须把 de1 排第一**。实测（2026-10，本机/用户所在网络）：
//   de1.api.radio-browser.info   200 + application/json ✓（冷启动首次请求 3.5s，之后 ~1.2s）
//   de2.api.radio-browser.info   200 + application/json ✓（~1.2s，最稳）—— 官方列表里它常被漏掉
//   all.api.radio-browser.info   ECONNRESET
//   api.radio-browser.info       HTTP 404 + text/html（根本不是 API 响应）
//   nl1 / at1 / fi1.api...       官方已下线（ENOTFOUND，失败很快，留着只为将来可能恢复）
// 所以这里按"实测可用"排序；运行时会**自动回退**（显式 BASE 若设了则优先），并把第一个真正
// 可用的镜像记住（radioRbBase），后续搜索不再去重试坏镜像。判"可用"的判据刻意严，见 radioFetchRbJson。
// DSHW_RADIO_BROWSER_MIRRORS 同时也是离线测试钩子：把它指向桩就能离线验证回退逻辑。
const RADIO_BROWSER_MIRRORS = String(process.env.DSHW_RADIO_BROWSER_MIRRORS
  || 'https://de1.api.radio-browser.info,https://de2.api.radio-browser.info,https://all.api.radio-browser.info,'
    + 'https://api.radio-browser.info,https://nl1.api.radio-browser.info,https://at1.api.radio-browser.info,'
    + 'https://fi1.api.radio-browser.info')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)
const SOMAFM_URL = String(process.env.DSHW_SOMAFM_URL || 'https://somafm.com/channels.json')
const RADIO_UA = String(process.env.DSHW_RADIO_UA
  || 'dsh-whale-widget-radio/1.0 (+https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)')
// 状态文件：**刻意另开一个**，不塞进 .dshw-size.json / .dshw-usage.json ——
// 那两张表的每个键都必须有运行时消费方（tools/check-dead-settings.mjs 会审计，见它的文件头），
// 而电台收藏是"在线数据"、与挂件外观/记账无关，混进去只会让两边的键审计互相污染。
const RADIO_STATE_NAME = '.dshw-radio.json'
const RADIO_FILE_CANDIDATES = [
  path.join(DSH_HOME, RADIO_STATE_NAME),
  path.join(DSH_HOME, 'profiles', 'web', RADIO_STATE_NAME),
]
// 两个上游的稳定标识（前端也按这两个字符串传 source / 记 lastSource）
const RADIO_SOURCE_LABELS = { rb: 'Radio Browser', somafm: 'SomaFM' }
const RADIO_MAX_FAVORITES = 100
const RADIO_MAX_STREAMS = 4
const RADIO_SEARCH_DEFAULT_LIMIT = 30
const RADIO_SEARCH_MAX_LIMIT = 50
// 上游 JSON（搜索 / 频道表）的整请求超时；音频代理另有一套"连接 + 首字节"超时（见下），
// 因为电台是**无限流**，给它一个总超时等于到点就掐断正在听的台。
const RADIO_JSON_TIMEOUT_MS = 10000
// Radio Browser **单个镜像**的尝试超时：实测 de1 的**冷启动首次**请求要 3.5s（之后 ~1.2s），
// 所以卡在 4s 会让健康镜像被误判为坏镜像、白白回退（真发生过）。取 6s 兼顾"坏镜像让位"与
// "冷启动不误杀"；总预算再压一层（见 RADIO_BROWSER_TOTAL_BUDGET_MS），避免最坏情况把前端拖死。
const RADIO_BROWSER_PROBE_TIMEOUT_MS = 6000
// 一次搜索在**所有镜像**上花的总预算上限：到点就不再试后面的镜像，直接回 502 可读文案。
// 没有它的话"7 个候选 × 6s"最坏能到 40s+，前端的加载态会一直转。
const RADIO_BROWSER_TOTAL_BUDGET_MS = 12000
const RADIO_STREAM_TIMEOUT_MS = 15000
const RADIO_STREAM_MAX_HOPS = 5
// 播放列表（.pls / .m3u）解引用：**SomaFM 给的就是 .pls**（playlists[].url 形如
// https://api.somafm.com/groovesalad256.pls），所以代理必须先把它解析成真正的音频流地址。
// 深度上限 2：防 A→B→A 循环或无限套娃（每层都要过一遍 SSRF 检查，深度不设限等于放大攻击面）。
const RADIO_PLAYLIST_MAX_DEPTH = 2
// 播放列表文件很小（几百字节），但仍然限长：别让一个恶意/异常的上游用它把内存灌满。
const RADIO_PLAYLIST_MAX_BYTES = 64 * 1024
// 播放列表类 Content-Type。**必须在"是不是音频"之前判定**（先解析、解析不出来再拒）：
// 注意 audio/x-scpls 与 audio/x-mpegurl **也以 audio/ 开头**，靠白名单拦不住 ——
// 曾经因此把 .pls 文本原样流给了 `<audio>`：用户看到"正在播放"却一点声音都没有（静默无声）。
const RADIO_PLAYLIST_MIMES = [
  'audio/x-scpls', 'audio/scpls',
  'audio/x-mpegurl', 'audio/mpegurl',
  'application/vnd.apple.mpegurl',
  'text/uri-list', 'text/plain',
]
// 代理**只**转发下面这几类响应：否则这条路由就是一个"通用网页代理"，
// 任何能打开本机页面的人都能借宿主的网络身份去读任意 http 服务的响应体。
// 注意 audio/ 是**前缀**匹配（audio/mpeg、audio/aac、audio/ogg… 几十种），其余按全等匹配。
const RADIO_STREAM_MIMES = [
  'application/ogg',
  'application/octet-stream',
  'video/mp4',
  'video/webm',
  'application/vnd.apple.mpegurl',
]
// DSHW_RADIO_ALLOW_HOSTS：SSRF 防护的**显式窄口径逃生口**（默认空 = 只允许公网地址）。
// 为什么需要它：用户在**自己局域网**里跑 Icecast / 自建电台（或本机测试）时，私网地址会被
// SSRF 防护拒掉；没有这个开关，用户唯一的选择就是"关掉整个防护"，那是更糟的结果。
// 语义刻意做窄 —— **精确匹配** `host` 或 `host:port`，不支持通配符 / 前缀 / CIDR：
// 它必须能"放行某一台"，而不能变成"一键关掉 SSRF 防护"。
// 命中名单**只**跳过"私网 / 回环 / 链路本地"那一段判定；协议白名单、URL 不许带用户名密码、
// 逐跳重定向检查、Content-Type 白名单照旧**全部**执行（所以第一跳放行、第二跳跳到 127.0.0.1
// 且不在名单里时，仍然会被拒）。
// 解析失败 / 空值一律按"空名单"处理（fail-closed）。
function parseRadioAllowHosts(raw) {
  const hosts = new Set()
  const hostPorts = new Set()
  const add = (host, port) => {
    const h = String(host || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
    if (!h) return
    if (port) hostPorts.add(h + ':' + String(port))
    else hosts.add(h)
  }
  for (const item of String(raw || '').split(',')) {
    const entry = item.trim().toLowerCase()
    if (!entry) continue
    const br = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(entry) // [::1]:8080 / [::1]
    if (br) { add(br[1], br[2]); continue }
    const hp = /^([^:]+):(\d{1,5})$/.exec(entry) // host:port（主机名或 IPv4）
    if (hp) { add(hp[1], hp[2]); continue }
    add(entry, null) // 纯 host（也涵盖不带端口的 IPv6 字面量）
  }
  return { hosts, hostPorts }
}
const RADIO_ALLOW_HOSTS = parseRadioAllowHosts(process.env.DSHW_RADIO_ALLOW_HOSTS)
// 取 URL 的主机名（去掉 IPv6 的方括号 —— WHATWG URL 的 hostname 对 IPv6 会**带**方括号）
function radioHostOf(target) {
  try {
    const u = target instanceof URL ? target : new URL(String(target))
    return String(u.hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  } catch (err) { return '' }
}
// 名单命中判定：先看 `host:port` 全等，再看"只写了 host"的任意端口条目。
// 端口取 URL 里的显式端口，缺省时按协议的默认端口（80/443）—— 否则 `host:80` 这种写法
// 在 `http://host/`（无端口）上永远匹配不上，用户会以为开关坏了。
function radioAllowHit(host, port) {
  try {
    if (RADIO_ALLOW_HOSTS.hosts.has(host)) return true
    return !!port && RADIO_ALLOW_HOSTS.hostPorts.has(host + ':' + String(port))
  } catch (err) { return false }
}
// 主机名后缀：这些名字按约定指向本机/内网，**即使现在解析到公网地址也不可信**
//（`x.local` / `x.internal` / `x.home.arpa` 都是"本地解析"保留域）。
function radioHostnameSuffixRejection(host) {
  const h = String(host || '').toLowerCase()
  if (!h) return '地址缺少主机名'
  if (h === 'localhost' || h.endsWith('.localhost')) return '拒绝内网地址（localhost）'
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) {
    return '拒绝内网地址（本地解析域名）'
  }
  return null
}
// IPv4 字面量 → 是否落在"私网 / 保留 / 组播"范围。返回 null = 放行，否则是拒绝原因（中文）。
// ⚠️ 无法识别的一律**拒绝**（fail-closed）：这个函数只被"已经解析出来的地址"调用，
// 出现不认识的形状说明上游换了解析器，宁可拒绝也不要放过。
function radioIpv4Rejection(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim())
  if (!m) return '拒绝无法识别的目标地址'
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (o.some((x) => x > 255)) return '拒绝无法识别的目标地址'
  const a = o[0]
  const b = o[1]
  if (a === 0) return '拒绝内网地址（0.0.0.0/8）'
  if (a === 127) return '拒绝内网地址（回环 127.0.0.0/8）'
  if (a === 10) return '拒绝内网地址（10.0.0.0/8）'
  if (a === 172 && b >= 16 && b <= 31) return '拒绝内网地址（172.16.0.0/12）'
  if (a === 192 && b === 168) return '拒绝内网地址（192.168.0.0/16）'
  if (a === 169 && b === 254) return '拒绝内网地址（链路本地 169.254.0.0/16）'
  if (a === 100 && b >= 64 && b <= 127) return '拒绝内网地址（CGNAT 100.64.0.0/10）'
  if (a === 192 && b === 0 && o[2] === 0) return '拒绝保留地址（192.0.0.0/24）'
  if (a === 198 && (b === 18 || b === 19)) return '拒绝保留地址（198.18.0.0/15）'
  if (a >= 224 && a <= 239) return '拒绝组播地址（224.0.0.0/4）'
  if (a >= 240) return '拒绝保留地址（240.0.0.0/4）'
  return null
}
// IPv6 字面量 → 同一套判断。支持压缩写法、带 zone（fe80::1%eth0）、以及内嵌 IPv4 的三种形式。
// 为什么非要自己解析：`::ffff:127.0.0.1` 这类 IPv4 映射地址能**绕过**只查 IPv4 的防护
//（URL 还会把它规范化成 `::ffff:7f00:1`，字符串比较更认不出来），必须解出内嵌地址再按 IPv4 判。
function radioIpv6Rejection(ip) {
  let s = String(ip || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (s.indexOf(':') < 0) return '拒绝无法识别的目标地址'
  const v4tail = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s)
  if (v4tail) {
    const quad = v4tail[2].split('.').map(Number)
    if (quad.some((x) => x > 255)) return '拒绝无法识别的目标地址'
    s = v4tail[1] + ((quad[0] << 8) | quad[1]).toString(16) + ':' + ((quad[2] << 8) | quad[3]).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return '拒绝无法识别的目标地址'
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1) { if (head.length !== 8) return '拒绝无法识别的目标地址' }
  else if (missing < 1) return '拒绝无法识别的目标地址'
  const groups = halves.length === 2 ? head.concat(new Array(missing).fill('0')).concat(tail) : head
  if (groups.length !== 8) return '拒绝无法识别的目标地址'
  const h = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return '拒绝无法识别的目标地址'
    h.push(parseInt(g, 16))
  }
  const v4Of = (hi, lo) => [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.')
  if (h.every((v) => v === 0)) return '拒绝保留地址（::）'
  if (h.slice(0, 7).every((v) => v === 0) && h[7] === 1) return '拒绝内网地址（回环 ::1）'
  // IPv4 映射（::ffff:a.b.c.d）与 IPv4 兼容（::a.b.c.d）：解出内嵌地址，交给 IPv4 那套规则
  if (h.slice(0, 6).every((v) => v === 0)) return radioIpv4Rejection(v4Of(h[6], h[7]))
  if (h.slice(0, 5).every((v) => v === 0) && h[5] === 0xffff) return radioIpv4Rejection(v4Of(h[6], h[7]))
  // NAT64 映射 64:ff9b::/96：末 32 位是 IPv4（公网地址照常放行，私网地址照旧拒绝）
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return radioIpv4Rejection(v4Of(h[6], h[7]))
  }
  if ((h[0] & 0xfe00) === 0xfc00) return '拒绝内网地址（fc00::/7 唯一本地）'
  if ((h[0] & 0xffc0) === 0xfe80) return '拒绝内网地址（fe80::/10 链路本地）'
  return null
}
// 上游响应的 Content-Type 白名单。返回 null = 放行，否则是拒绝原因（中文）。
// 缺 Content-Type 时按 application/octet-stream 放行（不少 Icecast 就是不带头，这是正常情况）；
// text/* / JSON / XML 一律拒 —— 放过去这条路由就成了通用网页代理。
// ⚠️ 播放列表类（audio/x-scpls 等）在这里**必须**先被拒：它们也以 `audio/` 开头，
//    光靠前缀匹配会漏过去（历史上正是这样把 .pls 文本流给了 `<audio>` ⇒ 静默无声）。
//    正常路径上不会走到这里 —— radioProxyStream 会先把播放列表解引用成真流；
//    这里只是**兜底 fail-closed**：万一解引用失败/类型没识别出来，也绝不把它当音频下发。
function radioStreamTypeRejection(contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (!mime) return null
  if (RADIO_PLAYLIST_MIMES.indexOf(mime) >= 0) return '上游返回的是播放列表而不是音频流（' + mime + '）'
  if (mime.startsWith('audio/')) return null
  if (RADIO_STREAM_MIMES.indexOf(mime) >= 0) return null
  return '上游返回的不是音频（' + mime + '）'
}
// 目标地址看起来是不是播放列表（只看路径后缀）。用于**发请求前**决定"这次要不要带 Range"：
// 播放列表是个小文本文件，带 Range 只会让它被截断，对后面的解引用没有好处。
function radioPlaylistPathOf(target) {
  let p = ''
  try { p = new URL(String(target)).pathname.toLowerCase() } catch (err) { return '' }
  if (p.endsWith('.pls')) return 'pls'
  if (p.endsWith('.m3u') || p.endsWith('.m3u8')) return 'm3u'
  return ''
}
// 这个响应是不是播放列表？返回 'pls' / 'm3u' / ''（不是）。
// 两条判据取并集：**路径后缀**（.pls/.m3u/.m3u8）与 **Content-Type**
//（SomaFM 给 .pls 时是 audio/x-scpls；有些站给 .m3u 时干脆是 text/plain）。
// Content-Type 优先决定格式：m3u 家族的 mime 配 .pls 路径时按路径算（避免把 pls 当 m3u 解析）。
function radioPlaylistKind(target, contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase()
  const byPath = radioPlaylistPathOf(target)
  if (mime === 'audio/x-scpls' || mime === 'audio/scpls') return 'pls'
  if (mime === 'audio/x-mpegurl' || mime === 'audio/mpegurl'
    || mime === 'application/vnd.apple.mpegurl' || mime === 'text/uri-list' || mime === 'text/plain') {
    return byPath === 'pls' ? 'pls' : 'm3u'
  }
  return byPath
}
// 把播放列表里的一行/一个值解析成绝对 http(s) 地址（相对地址按播放列表自身的位置解析）。
function radioAbsoluteUrl(raw, base) {
  try {
    const u = new URL(String(raw || '').trim(), base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.toString()
  } catch (err) { return '' }
}
// 从播放列表文本里取**第一个可用地址**：
//   .pls（INI 风格）→ 任一存在的 `FileN=`（File1 优先，按文件里的顺序）
//   .m3u/.m3u8      → 第一条非 `#` 非空行
// 解析不出来返回 ''（调用方据此回 502 可读文案），**绝不**把播放列表原样下发给前端。
function radioParsePlaylist(text, base, kind) {
  const lines = String(text || '').split(/\r?\n/)
  if (kind === 'pls') {
    for (const line of lines) {
      const m = /^\s*file\d*\s*=\s*(.+)$/i.exec(line)
      if (!m) continue
      const abs = radioAbsoluteUrl(m[1], base)
      if (abs) return abs
    }
    return ''
  }
  for (const line of lines) {
    const s = line.trim()
    if (!s || s.charAt(0) === '#') continue
    // 只认"像地址"的行（`http(s)://…`、绝对路径 `/…`、或 `host:port/…`）。为什么不一概交给
    // URL 解析器：一段随手的文本（比如 `text/plain` 的错误页 `<html>…`）会被解析成
    // `http://host/<html>` 这种**看起来合法**的相对地址，白白再打一次上游、还绕一层深度。
    if (!/^(https?:\/\/|\/|[a-z0-9.-]+:\d{2,5}\/)/i.test(s)) continue
    const abs = radioAbsoluteUrl(s, base)
    if (abs) return abs
  }
  return ''
}

  // ═══════════════════════════════════════════════════════════════════════
  // 信任栅栏（回环判定 / 写拒绝 / 路由包装）（原样搬自挂件 lib/index.js 1046-1181）
  // ═══════════════════════════════════════════════════════════════════════
// —— 浏览器信任栅栏（issue #92 建立，issue #136 补 fail-closed）——
// dsh 的 connection 服务提供 requestRejection(req)：Host/Origin 被伪造（DNS 重绑定）或未认证的
// 请求必须被拒。**但这个方法在较老的 dsh 上不存在**（#136 实测：0.1.5-rc.2/rc.3 有、0.1.0-rc.3 没有），
// 而旧实现在"服务缺失"与"栅栏自己抛异常"两条路径上都是 fail-open（放行）—— 于是 22 条 /dsh-whale/*
// 路由会**集体**失去校验：伪造 Host 可读写、普通跨站 POST 可直接写配置，而 api-models.json 还连着
// ctx.credentials（可 set/delete key）。现在改成三层：
//   ① **插件自己的轻量校验**（永远先跑；正常浏览器与本地脚本都不受影响）：
//      Host 必须是回环权威或 DSHW_TRUSTED_HOSTS 里显式声明的，`Sec-Fetch-Site: cross-site` 一律拒，
//      带 Origin 时必须与 Host 同源；
//   ② 宿主栅栏可用 → **委托**它（不重写它的语义：它里面还有一层浏览器鉴权 401），返回码照用；
//      **它抛异常则按拒绝处理**（旧实现这条路径静默放行，且连 warn 都没有）；
//   ③ 宿主栅栏不可用 → 只靠 ①，并在**插件加载时**就打一条醒目 warn（不是等第一次请求才打）。
const TRUSTED_AUTHORITIES = String(process.env.DSHW_TRUSTED_HOSTS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
// 只认回环：localhost / *.localhost / 127.0.0.0/8（逐段校验，防 `127.0.0.1.evil.com` 这类相似域名）/ ::1
function isLoopbackHostname(hn) {
  const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}
// 通过 → null；否则返回应当拒绝的状态码。
// opts.fenceAvailable：宿主栅栏此刻可用时，**非回环 Host 交给它判** —— 它知道 dsh 自己的
// `--trusted-host` 声明了谁；我们只在"确实没有栅栏"时才回落到 DSHW_TRUSTED_HOSTS。
// （0.3.11 把自校验放在委托之前，导致宿主已信任的权威在插件这边被 403，见 issue #136 后续的 A/B。）
function selfRejection(req, opts) {
  try {
    const headers = (req && req.headers) || {}
    let hostUrl = null
    try { hostUrl = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 } // 缺 Host / 畸形 → 拒
    const hostname = hostUrl.hostname
    const authority = hostUrl.host
    if (!isLoopbackHostname(hostname)) {
      const listed = TRUSTED_AUTHORITIES.some((e) => (e.indexOf(':') >= 0 ? e === authority.toLowerCase() : e === hostname.toLowerCase()))
      const fenceAvailable = !!(opts && opts.fenceAvailable)
      if (!listed && !fenceAvailable) return 403
    }
    // 下面两条与"信任列表"无关，任何情况下都执行：跨站标记、Origin 与 Host 不同源。
    const site = String(headers['sec-fetch-site'] || '').toLowerCase()
    if (site === 'cross-site') return 403
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let originUrl = null
      try { originUrl = new URL(origin) } catch (err) { return 403 }
      if (originUrl.host.toLowerCase() !== authority.toLowerCase()) return 403
    }
    return null
  } catch (err) { return 403 } // 校验器自身出错 → 拒绝（fail-closed）
}
function connectionFence() {
  try {
    const conn = ctx.get('connection') || ctx.connection
    return conn && typeof conn.requestRejection === 'function' ? conn : null
  } catch (err) { return null }
}
if (!connectionFence()) {
  try {
    console.warn('[whale-balance] 宿主信任栅栏不可用（connection.requestRejection 缺失）：已启用插件自带的回环/同源校验，'
      + '所有路由（含写接口）仍受它保护；若本机 dsh 部署在非回环地址（反代/局域网），请用环境变量 '
      + 'DSHW_TRUSTED_HOSTS 声明允许的 Host（逗号分隔，可带端口）。')
  } catch (err) {}
}
// v761（安全修复 S1）：**写请求（POST/PUT/PATCH/DELETE）必须来自本机（回环）**。
// 为什么：任意持有 DSH Web 会话的人都能 `POST /dsh-whale/api-models.json` 写一个自定义模型，
// 而余额 / 探活 / 额度会**带着解析出来的真实凭据**去请求模型里那个 URL ⇒ 凭据外带。
// 「改配置」等于「决定把凭据发往哪里」，所以它必须与"坐在这台机器前"绑定；
// **只读接口不受影响**（局域网里仍能正常看挂件）。
// 运维若确实需要远端管理，显式声明 DSHW_ADMIN_HOSTS（逗号分隔，可带端口），默认为空。
const ADMIN_AUTHORITIES = String(process.env.DSHW_ADMIN_HOSTS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
function writeRejection(req) {
  try {
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (!WRITE_METHODS.has(method)) return null
    const headers = (req && req.headers) || {}
    let hostUrl = null
    try { hostUrl = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 }
    if (isLoopbackHostname(hostUrl.hostname)) return null
    const authority = hostUrl.host.toLowerCase()
    const hostname = hostUrl.hostname.toLowerCase()
    if (ADMIN_AUTHORITIES.some((e) => (e.indexOf(':') >= 0 ? e === authority : e === hostname))) return null
    if (!writeRejection.warned) {
      writeRejection.warned = true
      try {
        console.warn('[whale-balance] 已拒绝一个来自非本机的**写请求**（Host=' + authority + '）。'
          + '自 0.3.15 起，配置与凭据的改动只能在**本机**（回环地址）打开界面进行 —— '
          + '否则任何拿到 Web 会话的人都能把凭据改指向自己的服务器，从而把真实 API key 带走。'
          + '确需远端管理，请用环境变量 DSHW_ADMIN_HOSTS 声明允许的管理主机。')
      } catch (err) {}
    }
    return 403
  } catch (err) { return 403 } // 自身出错 → 拒绝（fail-closed）
}
function rejectedLocal(req, res) {
  const deny = (code) => {
    try { res.statusCode = code || 403; res.end() } catch (err) {}
    return true
  }
  const conn = connectionFence()
  // 先算栅栏可用性，再自校验：非回环 Host 在"栅栏可用"时交给栅栏判（它知道 --trusted-host）
  const self = selfRejection(req, { fenceAvailable: !!conn })
  if (self !== null) return deny(self)
  // v761（安全修复 S1）：写完再放行 —— 读请求不受影响
  const write = writeRejection(req)
  if (write !== null) return deny(write)
  if (!conn) return false // 已通过自校验；此刻没有宿主栅栏可委托（加载时已 warn）
  let code
  try {
    code = conn.requestRejection(req)
  } catch (err) {
    // 旧实现这里是 `return false`：栅栏自己抛异常被当成"没被拒"而静默放行（#136 的第二条路径）
    if (!rejected.warned) {
      rejected.warned = true
      try { console.warn('[whale-balance] 信任栅栏抛异常，已按拒绝处理：' + String((err && err.message) || err)) } catch (e2) {}
    }
    return deny(403)
  }
  if (code === undefined || code === null || code === false) return false
  return deny(typeof code === 'number' ? code : 403)
}
// 统一注册入口：所有路由自动套上信任栅栏
  // —— 搬迁改动：栅栏**组合**而不是替换 ——
  // 宿主的 rejected() 是"DSH 会话 cookie 或桌面版通行证"（只有我们自己的 /dsh-pet/* 需要它）；
  // 搬过来的这份是挂件的"回环 Host + 自声明信任名单 + 写请求额外校验"。两者**都要满足**才放行：
  //   · 丢掉宿主的 → 桌面版壳（没有 DSH cookie，只有通行证）发起的请求会被拒；
  //   · 丢掉搬过来的 → 音乐/电台的写接口就失去了回环 Host 校验（music-harness 明确要求
  //     伪造 Host 的写请求必须 403，而且那几条路由不读宿主 cookie，宿主的栅栏对它们是空转）。
  // 所以：宿主说拒 → 拒；宿主说放行 → 再看搬过来的这份。
  const rejectedLocalCombined = (req, res) => {
    if (hostRejected && hostRejected(req, res)) return true
    return rejectedLocal(req, res)
  }
  const rejected = rejectedLocalCombined

  // —— 搬迁改动：统一注册入口 ——
  // 只做转发：真正干活的是 registerVia（栅栏与路由清单都在那里，见它的注释）。
  function registerRoute(route) {
    return registerVia(route.kind, route.path, route.handler)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 读请求体（带体积上限）（原样搬自挂件 lib/index.js 3394-3410）
  // ═══════════════════════════════════════════════════════════════════════
function readBodyMax(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

  // ═══════════════════════════════════════════════════════════════════════
  // 音乐辅助函数（原样搬自挂件 lib/index.js 4318-4623）
  // ═══════════════════════════════════════════════════════════════════════
// —— 音乐播放器：托管目录 whale-music/（与音效库 whale-audio/ 同形但**不建索引**）——
// 目录不存在时自动创建，与 pickAudioDir() 同一写法（候选表第一个可写的胜出）。
function pickMusicDir() {
  for (const p of MUSIC_DIR_CANDIDATES) {
    try {
      fs.mkdirSync(p, { recursive: true })
      fs.accessSync(p, fs.constants.W_OK)
      return p
    } catch (err) {}
  }
  return MUSIC_DIR_CANDIDATES[0]
}

// 状态默认值：文件缺失/损坏、或某个键非法时都用它兜底。
// ⚠️ 前端也会内置同一份默认值；两处必须一致，否则表现是"首次打开界面显示 0.9、存一次变 1"。
function defaultMusicSettings() {
  return { volume: 0.9, loop: 'all', shuffle: false, pressMode: true, autoplay: false }
}

function defaultMusicState() {
  return { version: 1, customDir: '', settings: defaultMusicSettings() }
}

// 设置白名单 + 逐键类型校验：未知键**忽略**，非法值退回当前值/默认值。
// 为什么不用 Object.assign 直接合并：请求体来自页面，直接合并会把任意键写进状态文件
//（多余键既没人读、又会污染用户的配置文件），而 check-dead-settings.mjs 的口径就是
//「写进去的键必须在运行时被读到」—— 所以宁可逐个挑。
function normalizeMusicSettings(raw, base) {
  const out = Object.assign(defaultMusicSettings(), base || {})
  // base 也可能是从磁盘读回来的坏值，所以再校验一遍
  if (typeof out.volume !== 'number' || !isFinite(out.volume) || out.volume < 0 || out.volume > 1) out.volume = 0.9
  if (out.loop !== 'off' && out.loop !== 'all' && out.loop !== 'one') out.loop = 'all'
  out.shuffle = out.shuffle === true
  out.pressMode = out.pressMode !== false
  out.autoplay = out.autoplay === true
  if (!raw || typeof raw !== 'object') return out
  if (typeof raw.volume === 'number' && isFinite(raw.volume) && raw.volume >= 0 && raw.volume <= 1) out.volume = raw.volume
  if (raw.loop === 'off' || raw.loop === 'all' || raw.loop === 'one') out.loop = raw.loop
  if (typeof raw.shuffle === 'boolean') out.shuffle = raw.shuffle
  if (typeof raw.pressMode === 'boolean') out.pressMode = raw.pressMode
  if (typeof raw.autoplay === 'boolean') out.autoplay = raw.autoplay
  return out
}

function readMusicState() {
  for (const p of MUSIC_FILE_CANDIDATES) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      // 文件在但结构不对（手改坏 / 旧格式）→ 兜底默认值，**绝不抛**：
      // 抛出去会让 music.json 直接 500，整个播放器（连歌单）都点不开。
      if (parsed && typeof parsed === 'object') {
        return {
          version: 1,
          customDir: typeof parsed.customDir === 'string' ? parsed.customDir : '',
          settings: normalizeMusicSettings(parsed.settings),
        }
      }
    } catch (err) {}
  }
  return defaultMusicState()
}

// 原子写：先写同目录临时文件再 rename。为什么不用 writeFileSync 直写 —— 中途断电/宿主被杀
// 会留下半个 JSON，下次读就是"设置每次都被重置"，而这种损坏最难排查（账本那边同理）。
function writeMusicState(state) {
  const body = JSON.stringify({
    version: 1,
    customDir: typeof state.customDir === 'string' ? state.customDir : '',
    settings: normalizeMusicSettings(state.settings),
  }, null, 2)
  for (const p of MUSIC_FILE_CANDIDATES) {
    const temp = p + '.tmp-' + process.pid
    try {
      fs.writeFileSync(temp, body, 'utf8')
      fs.renameSync(temp, p)
      return true
    } catch (err) {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch (cleanupErr) {}
    }
  }
  return false
}

// 曲目 id：绝对路径小写 + 正斜杠规范化后取 sha1 前 16 位。
// 为什么不拿文件名/路径直接当 id：id 是**下发给浏览器**的，能反推路径就等于把用户的
// 目录结构（常含用户名）暴露到页面上；而且 id 最终要参与"扫回来反查文件"，
// 用一个纯十六进制串可以让"客户端字符串拼路径"这条路从根上走不通（见 findMusicTrack）。
function musicIdOf(absPath) {
  const norm = String(absPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return createHash('sha1').update(norm).digest('hex').slice(0, 16)
}

function musicExtOf(name) {
  const s = String(name || '')
  const i = s.lastIndexOf('.')
  return i > 0 ? s.slice(i + 1).toLowerCase() : ''
}

// f 是否在 dir 里（用于判定"这首歌属于托管目录"，删除权限只看这一个判断）
function isInsideMusicDir(dir, absPath) {
  try {
    const rel = path.relative(path.resolve(dir), path.resolve(absPath))
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
  } catch (err) { return false }
}

// **只扫一层**（不递归子目录）：目录名是用户自己组织的，递归会把"还没整理/备份"的
// 一堆音频也拉进歌单；只认 MUSIC_EXTS 白名单里的普通文件。
// 返回的 path 只在本进程内用（不下发），下发给前端的字段见 musicPayload()。
function scanMusicDir(dir, managed) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return [] // 目录没了/没权限：当作空目录，由调用方决定要不要报 dirError
  }
  const out = []
  for (const ent of entries) {
    try {
      if (!ent.isFile()) continue
      const name = String(ent.name || '')
      const ext = musicExtOf(name)
      if (MUSIC_EXTS.indexOf(ext) < 0) continue
      const abs = path.join(dir, name)
      const st = fs.statSync(abs)
      if (!st.isFile()) continue
      out.push({
        id: musicIdOf(abs),
        name,
        title: name.slice(0, name.length - ext.length - 1),
        ext,
        size: st.size,
        mtime: Math.round(st.mtimeMs),
        inManaged: isInsideMusicDir(managed, abs),
        path: abs,
      })
    } catch (err) {}
  }
  return out
}

// 按文件名本地化排序：localeCompare + numeric —— 否则 track10 会排在 track2 前面，
// 中文名也会按码点乱序（用户看到的是"歌单没排序"）。
// 显式指定 zh-Hans-CN 是为了**跨机器稳定**（默认 locale 跟随系统，同一个目录换个环境顺序就变）；
// 但 small-icu 的运行时可能不认这个 locale（localeCompare 会抛 RangeError）——排序失败绝不能
// 把整个 music.json 打成 500，所以逐级退化到默认 locale、再退化到不依赖 ICU 的比较。
function sortMusicTracks(tracks) {
  const byName = (locale) => (a, b) => String(a.name).localeCompare(String(b.name), locale, { numeric: true, sensitivity: 'base' })
  try {
    return tracks.slice().sort(byName('zh-Hans-CN'))
  } catch (err) {
    try { return tracks.slice().sort(byName(undefined)) } catch (err2) {
      return tracks.slice().sort((a, b) => (String(a.name) < String(b.name) ? -1 : (String(a.name) > String(b.name) ? 1 : 0)))
    }
  }
}

// 歌单 = 各扫描目录曲目的**并集**，按 id 去重、最后统一排序。
// 为什么是并集而不是"只扫当前生效目录"：托管目录（whale-music/）是插件自己的曲库，
// 里面的歌**必须始终出现在列表里** —— 否则用户一旦把扫描目录指向别的文件夹（自定义目录），
// 刚导入进托管目录的歌就从列表里消失了，表现成"导入成功但列表里没有"。
// 自定义目录只是"额外再扫一个文件夹"。去重按 id：两个目录相同时（或自定义目录失效、
// dir 退回托管目录时）同一个文件只会出现一次。inManaged 仍由 scanMusicDir 按文件真实位置标注。
function unionMusicTracks(dirs, managed) {
  const byId = new Map()
  for (const d of dirs) {
    for (const t of scanMusicDir(d, managed)) {
      if (!byId.has(t.id)) byId.set(t.id, t)
    }
  }
  return sortMusicTracks([...byId.values()])
}

// music.json 的响应体（GET 与四种 POST 成功时**同一个形状**，前端拿到就整体刷新）
function musicPayload() {
  const managed = pickMusicDir()
  const state = readMusicState()
  const custom = state.customDir
  let dir = managed
  let dirError = null
  if (custom) {
    // 自定义目录失效（U 盘拔了 / 改名 / 权限没了）不能让整个接口 500：
    // 退回托管目录，并把原因用 dirError 下发给前端显示 —— 歌照放，用户也知道为什么少了歌。
    try {
      if (!fs.statSync(custom).isDirectory()) throw new Error('不是文件夹')
      fs.accessSync(custom, fs.constants.R_OK)
      dir = custom
    } catch (err) {
      dir = managed
      dirError = '自定义目录不可用：' + String((err && err.message) || err).slice(0, 120)
    }
  }
  // 扫描范围 = 当前生效目录 ∪ 托管目录；两者相同（含自定义目录失效退回托管目录）时只扫一次，
  // 并集里也就不会出现重复项。⚠️ dir 字段语义不变：它仍是"当前生效目录"，供面板显示。
  const scanDirs = dir === managed ? [managed] : [dir, managed]
  const payload = {
    ok: true,
    managed,
    dir,
    custom,
    tracks: unionMusicTracks(scanDirs, managed).map((t) => ({
      id: t.id,
      name: t.name,
      title: t.title,
      ext: t.ext,
      size: t.size,
      mtime: t.mtime,
      inManaged: t.inManaged,
      url: '/dsh-whale/music-file?id=' + t.id,
    })),
    settings: state.settings,
    supported: MUSIC_EXTS.slice(),
  }
  if (dirError) payload.dirError = dirError
  return payload
}

// id → 曲目：**每次都重新扫描目录并按 id 匹配**。
// 这是防路径穿越的全部依据：客户端传来的字符串只参与「相等比较」（而且先按 16 位十六进制
// 校验），返回的绝对路径来自 readdirSync 的目录项 —— 任何 `../` / 盘符 / NUL 都不可能进路径。
// 扫描范围 = 当前生效目录 + 托管目录（**与 music.json 的歌单范围一致**，见 unionMusicTracks）：
// 这样列表里给出的 id 与这里能解析出的路径永远对得上。
function findMusicTrack(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return null
  const managed = pickMusicDir()
  const state = readMusicState()
  const dirs = []
  if (state.customDir) dirs.push(state.customDir)
  dirs.push(managed)
  for (const d of dirs) {
    for (const t of scanMusicDir(d, managed)) {
      if (t.id === id) return t
    }
  }
  return null
}

// 上传文件名消毒：name 是客户端给的字符串，不能让它影响落盘位置或形状。
//   ① 只取最后一段（同时干掉 `../..` 与 `C:\`）② 去控制字符 ③ 去 Windows 非法字符
//   ④ 去首部点（隐藏文件）与尾部点/空格（Windows 下建不出来）⑤ 限长
//   ⑥ 扩展名一律用**校验过的 ext 重新拼**，不信任用户文件名里的后缀
function sanitizeMusicName(rawName, ext) {
  let base = String(rawName || '').split(/[\\/]/).pop() || ''
  base = base.replace(/[\u0000-\u001f\u007f]/g, '')
  base = base.replace(/[<>:"|?*]/g, '_')
  base = base.trim().replace(/^\.+/, '').replace(/[. ]+$/, '')
  const innerExt = musicExtOf(base)
  if (innerExt && MUSIC_EXTS.indexOf(innerExt) >= 0) base = base.slice(0, base.length - innerExt.length - 1).replace(/[. ]+$/, '')
  if (base.length > 80) base = base.slice(0, 80).replace(/[. ]+$/, '')
  if (!base) return 'music.' + ext
  return base + '.' + ext
}

// 重名不覆盖：song.mp3 → song (2).mp3 → song (3).mp3 …
//（同一首歌传两次很常见；覆盖掉等于静默删了用户原来的文件）
function uniqueMusicName(dir, fileName) {
  const i = fileName.lastIndexOf('.')
  const stem = i > 0 ? fileName.slice(0, i) : fileName
  const ext = i > 0 ? fileName.slice(i) : ''
  if (!fs.existsSync(path.join(dir, fileName))) return fileName
  for (let n = 2; n < 1000; n++) {
    const cand = stem + ' (' + n + ')' + ext
    if (!fs.existsSync(path.join(dir, cand))) return cand
  }
  return stem + ' (' + Date.now().toString(36) + ')' + ext
}

// Range 解析（只支持单段，三种写法）：
//   `bytes=a-b` 闭区间；b 越界按末尾截断（RFC 7233 允许收窄）
//   `bytes=a-`  从 a 到末尾
//   `bytes=-n`  末尾 n 字节（浏览器 seek 时常用：先探尾巴拿总长度）
// 返回 null（没有 Range 头 → 全量 200）/ {start,end}（→ 206）/ {unsatisfiable:true}（→ 416）。
// 多段 Range（`a-b,c-d`）不支持：一律按不可满足回 416 —— 浏览器收到 416 会自动退回单段/全量，
// 比"我们自己拼 multipart/byteranges"简单且不会拼错。
function parseMusicRange(header, total) {
  const raw = String(header || '').trim()
  if (!raw) return null
  if (!/^bytes=/i.test(raw)) return { unsatisfiable: true }
  const spec = raw.slice(raw.indexOf('=') + 1)
  if (spec.indexOf(',') >= 0) return { unsatisfiable: true } // 多段不支持
  const m = /^(\d*)-(\d*)$/.exec(spec.trim())
  if (!m) return { unsatisfiable: true }
  const hasStart = m[1] !== ''
  const hasEnd = m[2] !== ''
  if (!hasStart && !hasEnd) return { unsatisfiable: true }
  if (total <= 0) return { unsatisfiable: true } // 空文件没有任何可满足的区间
  if (!hasStart) {
    const n = Number(m[2])
    if (!isFinite(n) || n <= 0) return { unsatisfiable: true } // `bytes=-0` 按 RFC 是不可满足
    return { start: Math.max(0, total - n), end: total - 1 }
  }
  const start = Number(m[1])
  if (!isFinite(start) || start >= total) return { unsatisfiable: true } // start 越界（含 start == total）
  let end = hasEnd ? Number(m[2]) : total - 1
  if (hasEnd && (!isFinite(end) || end < start)) return { unsatisfiable: true }
  if (end > total - 1) end = total - 1
  return { start, end }
}

function musicIdFromUrl(url) {
  try {
    const q = String(url || '').split('?')[1] || ''
    const m = /(?:^|&)id=([^&]+)/.exec(q)
    return m ? decodeURIComponent(m[1]) : ''
  } catch (err) { return '' }
}

  // ═══════════════════════════════════════════════════════════════════════
  // 路由 /dsh-whale/music.json（原样搬自挂件 lib/index.js 4625-4762）
  // ═══════════════════════════════════════════════════════════════════════
// —— 音乐接口 ①：列表 + 设置（GET）/ 四种 action（POST）——
// 写请求的"来源必须是本机（回环）"判断**不在这个 handler 里**：它由 registerRoute() 的
// 统一包装器（rejected → writeRejection）先跑，非回环的 POST 在进到这里之前就已经 403 了。
registerRoute({
  kind: 'exact',
  path: '/dsh-whale/music.json',
  handler: async (req, res) => {
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        // body 上限 64MB：上传是唯一的大 body（base64 音频塞在 JSON 里）。
        // 与 MUSIC_MAX_BYTES（48MB，解码后）配套：48 × 4/3 ≈ 64，两者不能单独改。
        let body
        try {
          body = await readBodyMax(req, 64 * 1024 * 1024)
        } catch (err) {
          // body 超限也要说清"上限是多少"：base64 把音频放大 4/3 倍 ⇒ 先撞上 body 上限的
          // 正是"音频太大"这一种情况（JSON 外壳只有几十字节），所以这里直接报音频上限，
          // 而不是把 readBodyMax 的 "body too large" 抛给用户看。
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '音频超过 ' + MUSIC_MAX_MB + 'MB 上限' }))
          return
        }
        const parsed = JSON.parse(body)
        const action = String((parsed && parsed.action) || '')
        if (action === 'set-settings') {
          // 只接受白名单键（volume/loop/shuffle/pressMode/autoplay），未知键忽略；
          // 合并写入（没传的键保持原值，避免"只改音量"把循环模式洗回默认）
          const state = readMusicState()
          state.settings = normalizeMusicSettings(parsed.settings, state.settings)
          writeMusicState(state)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(musicPayload()))
          return
        }
        if (action === 'set-dir') {
          const raw = String((parsed && parsed.dir) || '').trim()
          const state = readMusicState()
          if (!raw) {
            state.customDir = '' // '' = 复位为托管目录（不是"清除字段"）
          } else {
            const abs = path.resolve(raw)
            let isDir = false
            try { isDir = fs.statSync(abs).isDirectory() } catch (err) {}
            if (!isDir) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: '目录不存在或不是文件夹' }))
              return
            }
            // 存绝对路径：相对路径会被解析到宿主进程的工作目录，重启/换启动方式就漂了
            state.customDir = abs
          }
          writeMusicState(state)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(musicPayload()))
          return
        }
        if (action === 'upload') {
          const dataUrl = String((parsed && parsed.dataUrl) || '')
          const m = /^data:audio\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl)
          const extFromMime = m ? MUSIC_EXT_BY_MIME[m[1].toLowerCase()] : null
          if (!m || !extFromMime) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '音频数据格式不受支持（只接受 data:audio/<白名单格式>;base64,）' }))
            return
          }
          const buf = Buffer.from(m[2], 'base64')
          if (!buf.length) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '音频数据为空' }))
            return
          }
          if (buf.length > MUSIC_MAX_BYTES) {
            // 文案里的数字从常量算：改了上限不会出现"上限 48MB 但提示写 64MB"
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '音频超过 ' + MUSIC_MAX_MB + 'MB 上限' }))
            return
          }
          // 扩展名：name 的后缀在白名单里就用它（用户最清楚），否则按 mime 推断。
          // 两者都不认的情况在上面已经 400（MUSIC_EXT_BY_MIME 本身就是 mime 白名单）。
          const nameExt = musicExtOf(parsed && parsed.name)
          const ext = MUSIC_EXTS.indexOf(nameExt) >= 0 ? nameExt : extFromMime
          // ⚠️ 一律写进**托管目录**（即使当前扫的是自定义目录）：
          //   上传物是插件自己管理的，而"可删除"的边界也只有托管目录 —— 两边必须一致，
          //   否则会出现"传上去了却删不掉"（见 delete 分支）。
          const dir = pickMusicDir()
          const fileName = uniqueMusicName(dir, sanitizeMusicName(parsed && parsed.name, ext))
          const filePath = path.join(dir, fileName)
          fs.writeFileSync(filePath, buf)
          // 返回体与 GET 同形，另带 id：新文件的 id 直接由落盘路径算（而不是靠扫回来找）。
          // 歌单是「生效目录 ∪ 托管目录」，所以这首歌在 tracks[] 里一定看得见（inManaged=true），
          // 前端不需要靠这个 id 猜。
          const payload = musicPayload()
          payload.id = musicIdOf(filePath)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(payload))
          return
        }
        if (action === 'delete') {
          const track = findMusicTrack(String((parsed && parsed.id) || ''))
          if (!track) {
            res.writeHead(404, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '未找到该音频文件' }))
            return
          }
          // 安全边界：**只删托管目录**。自定义目录是用户自己的音乐库（可能是整个曲库目录），
          // "插件能扫到"不等于"插件有权删" —— 明确拒绝并说明原因。
          if (!track.inManaged) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '自定义目录里的文件不会被插件删除' }))
            return
          }
          try { fs.unlinkSync(track.path) } catch (err) {}
          // 播放列表是每次扫目录算出来的（没有索引文件要清理），状态文件里也不存曲目
          //（删一首歌不该动用户的音量/循环设置），所以这里没有额外的清理动作。
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(musicPayload()))
          return
        }
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
      return
    }
    // GET：列表 + 设置一次拿齐（前端不用为设置再发一次请求）。
    // 外面再包一层 try：musicPayload() 内部已尽量不抛（坏目录/坏状态文件都兜底），
    // 但"歌单接口 500"对用户就是整个播放器打不开 —— 宁可回一个 ok:false 的错误体。
    try {
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(musicPayload()))
    } catch (err) {
      res.writeHead(500, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
    }
  },
})

  // ═══════════════════════════════════════════════════════════════════════
  // 路由 /dsh-whale/music-file（原样搬自挂件 lib/index.js 4764-4821）
  // ═══════════════════════════════════════════════════════════════════════
// —— 音乐接口 ②：音频字节（<audio> 的 src）——
// 关键在 Range：**浏览器靠 206 判断"这条 URL 可以拖动进度条"**。只返 200 全量时，
// 进度条会退化成"只能从头播、不能 seek"（甚至不显示总时长），所以 200/206/416 三条路径
// 都必须给出正确的 Content-Range / Accept-Ranges。
registerRoute({
  kind: 'exact',
  path: '/dsh-whale/music-file',
  handler: (req, res) => {
    try {
      const track = findMusicTrack(musicIdFromUrl(req.url))
      if (!track) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('music unavailable')
        return
      }
      const total = track.size
      const mime = MUSIC_MIME_BY_EXT[track.ext] || 'application/octet-stream'
      const range = parseMusicRange(req.headers && req.headers.range, total)
      if (range && range.unsatisfiable) {
        // 416 必须带 Content-Range 的「bytes + 星号 + 斜杠 + 总长」形式（即 bytes 空格 星号 斜杠 total）：
        // 少了它浏览器会认为服务器不懂 Range，于是永远不做分段请求（表现为"拖不动进度条"）。
        // ⚠️ 这里刻意不写出那两个字符的连写 —— tools/check-dead-settings.mjs 用
        //    /\/\*[\s\S]*?\*\// 粗暴地剥块注释，源码里多一处裸的结束标记就会把一大段代码
        //    （含前端）当成注释吃掉，审计直接误报 8 个"死键"（实测踩过）。
        res.writeHead(416, {
          'Content-Type': mime,
          'Content-Range': 'bytes ' + '*' + '/' + total,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'Content-Length': '0',
        })
        res.end()
        return
      }
      const start = range ? range.start : 0
      const end = range ? range.end : total - 1
      const headers = {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(total > 0 ? end - start + 1 : 0),
        'Cache-Control': 'no-store',
      }
      if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total
      res.writeHead(range ? 206 : 200, headers)
      if (total <= 0) { res.end(); return } // 空文件：createReadStream 的 end=-1 会抛范围错
      // 流式下发（**绝不** readFileSync 整个文件）：一首 flac 动辄几十 MB，整读进内存
      // 会在拖动进度条时让宿主明显卡顿，大文件还可能把内存打爆。
      const stream = fs.createReadStream(track.path, { start, end })
      stream.on('error', () => { try { res.destroy() } catch (err) {} })
      stream.pipe(res)
    } catch (err) {
      try {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('music unavailable')
      } catch (e2) {}
    }
  },
})

  // ═══════════════════════════════════════════════════════════════════════
  // 电台辅助函数 + 三条路由（原样搬自挂件 lib/index.js 4823-5599）
  // ═══════════════════════════════════════════════════════════════════════
// ===================== 在线电台（Radio Browser / SomaFM）=====================
// 与"音乐播放器"并列的第二套音频来源：那边播**本机文件**，这边播**网络流**。
// 三条路由：radio.json（收藏 + 上次来源，读写各一次）、radio-search（上游搜索，仅回环）、
// radio-stream（音频流代理，仅回环）。两条只读接口里，radio-search / radio-stream
// **连读都要求回环** —— 它们会替宿主向外发请求，口径见 radioLoopbackRejection()。

// 状态文件字段一律**先消毒再落盘**：body 来自页面，超长字符串或非数字 bitrate 一旦写进去，
// 以后每次 GET 都要把它序列化下发给前端（而且用户手改坏文件时也要能读回来）。
function radioText(value, max) {
  const s = value === undefined || value === null ? '' : String(value)
  return s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max)
}
function radioInt(value, max) {
  const n = Number(value)
  return isFinite(n) && n > 0 ? Math.min(Math.round(n), max) : 0
}

// 归一化一条电台。**契约字段固定**（前端按它渲染），多余字段一律丢掉 ——
// 上游（尤其 Radio Browser）会返回几十个字段，全存进状态文件既没用又会随上游变动而膨胀。
// withVotes 只在下发给"搜索结果"时为 true：收藏里不存票数（票数会过期，存下来只会误导）。
function normalizeRadioStation(raw, fallbackSource, withVotes) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const out = {
    id: radioText(s.id, 120),
    name: radioText(s.name, 200),
    url: radioText(s.url, 2000),
    favicon: radioText(s.favicon, 1000),
    tags: radioText(s.tags, 400),
    country: radioText(s.country, 100),
    codec: radioText(s.codec, 40),
    bitrate: radioInt(s.bitrate, 1000000),
  }
  if (withVotes) out.votes = radioInt(s.votes, 100000000)
  const src = String(s.source || fallbackSource || '')
  out.source = src === 'somafm' ? 'somafm' : 'rb'
  return out
}

function defaultRadioState() {
  return { version: 1, lastSource: 'rb', updatedAt: 0, favorites: [] }
}

function readRadioState() {
  for (const p of RADIO_FILE_CANDIDATES) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      // 文件在但结构不对（手改坏 / 旧格式）→ 兜底默认值，**绝不抛**：
      // 抛出去会让 radio.json 直接 500，收藏与"上次来源"一起点不开。
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.favorites)) {
        return {
          version: 1,
          lastSource: parsed.lastSource === 'somafm' ? 'somafm' : 'rb',
          updatedAt: radioInt(parsed.updatedAt, Number.MAX_SAFE_INTEGER),
          // 读回来也过一遍归一化：上限在这里再兜一次（用户手改大数组时不会把响应撑爆）
          favorites: parsed.favorites.filter((f) => f && typeof f === 'object')
            .slice(0, RADIO_MAX_FAVORITES).map((f) => normalizeRadioStation(f, f.source, false)),
        }
      }
    } catch (err) {}
  }
  return defaultRadioState()
}

// 原子写：先写同目录临时文件再 rename（与 writeMusicState 同一写法，理由见那里的注释 ——
// 中途被杀会留下半个 JSON，下次读就是"收藏全没了"）。updatedAt 由这里统一盖章。
function writeRadioState(state) {
  const body = JSON.stringify({
    version: 1,
    lastSource: state && state.lastSource === 'somafm' ? 'somafm' : 'rb',
    updatedAt: Date.now(),
    favorites: ((state && state.favorites) || []).slice(0, RADIO_MAX_FAVORITES)
      .map((f) => normalizeRadioStation(f, f.source, false)),
  }, null, 2)
  for (const p of RADIO_FILE_CANDIDATES) {
    const temp = p + '.tmp-' + process.pid
    try {
      fs.writeFileSync(temp, body, 'utf8')
      fs.renameSync(temp, p)
      return true
    } catch (err) {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch (cleanupErr) {}
    }
  }
  return false
}

// radio.json 的响应体（GET 与三种 action 成功时**同一个形状**，前端拿到就整体刷新）
function radioPayload() {
  const state = readRadioState()
  return {
    ok: true,
    lastSource: state.lastSource,
    favorites: state.favorites,
    sources: {
      // rb 的 base 报**当前生效**的镜像（进程内第一个可用的；尚未探测过时报显式 BASE 或镜像表第一个）
      rb: { label: RADIO_SOURCE_LABELS.rb, base: radioRbBase },
      somafm: { label: RADIO_SOURCE_LABELS.somafm, base: SOMAFM_URL },
    },
    limits: { maxFavorites: RADIO_MAX_FAVORITES, maxStreams: RADIO_MAX_STREAMS },
  }
}

// —— "读也要求回环"栅栏（电台与网易云共用）——
// 与其它只读接口不同：radio-search / radio-stream / netease-search / netease.json 会
// **代表宿主**做事（向外发请求、起 PowerShell / reg / tasklist、唤起本机程序）。
// 局域网里的一个 DSH 会话不该能借宿主的身份做这些，所以这几条路由只认回环，**不接受**
// DSHW_TRUSTED_HOSTS / DSHW_ADMIN_HOSTS 的声明（那是"远程管理"的口子，不是"远程代理"的
// 口子）。回环判定复用 isLoopbackHostname（不另造一套），缺 Host / 畸形地址一律按拒绝处理
//（fail-closed）。what 只是给用户看的接口名，缺省保持电台原来的文案不变。
function radioLoopbackRejection(req, res, what) {
  try {
    const headers = (req && req.headers) || {}
    const hostUrl = new URL('http://' + String(headers.host || ''))
    if (isLoopbackHostname(hostUrl.hostname)) return false
  } catch (err) {} // 走下面的 403
  try {
    res.writeHead(403, JSON_HEADERS)
    res.end(JSON.stringify({ ok: false, error: (what || '在线电台接口') + '仅限本机（回环地址）访问' }))
  } catch (e2) {}
  return true
}

// —— SSRF 防护：返回 null = 放行，否则返回 {status, error}（error 是中文原因，直接下发前端）——
// 状态码的分配：**请求本身就畸形**（非 http/https、带用户名密码、没有主机名）→ 400；
// **目标地址不安全**（回环 / 私网 / 链路本地 / 保留段 / 本地解析域名）→ 403；
// **解析不出来 / 我们自己的内部错误** → 5xx（见 radioResolveFailure，**不是** 403）。
// 检查顺序固定：协议 → 用户名密码 → 显式放行名单 → 回环/域名后缀 → **全部**解析地址的范围。
// 逐跳都要重新调用它（见 radioProxyStream）：第一跳是公网、第二跳跳回 127.0.0.1
// 是最经典的 SSRF 绕过方式，只在入口查一次等于没查。
async function radioTargetRejection(target) {
  let u = null
  try { u = new URL(String(target)) } catch (err) { return { status: 400, error: '地址无法解析' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { status: 400, error: '只允许 http/https 地址' }
  // `https://user:pass@host/` 一律拒：凭据会随请求发出去，而且这是"藏在 URL 里的秘密"
  if (u.username || u.password) return { status: 400, error: '地址里不允许带用户名或密码' }
  const host = radioHostOf(u)
  if (!host) return { status: 400, error: '地址缺少主机名' }
  const port = u.port || (u.protocol === 'https:' ? '443' : '80')
  // 显式放行名单：**只**跳过下面的内网判定（协议、凭据、逐跳重定向、Content-Type 照旧）
  if (radioAllowHit(host, port)) return null
  if (isLoopbackHostname(host)) return { status: 403, error: '拒绝内网地址（回环）' }
  const byName = radioHostnameSuffixRejection(host)
  if (byName) return { status: 403, error: byName }
  let addrs = []
  try {
    // ⚠️ 必须用 dns.promises.lookup。**回调式的 `dns.lookup(host, {all:true})` 少了 callback 会
    //   直接抛 ERR_INVALID_ARG_TYPE**（它不是"解析失败"），而这个抛被下面的 catch 吞成
    //   "域名无法解析 → 403" —— 于是所有**以主机名给出的目标**（真实电台 ice1.somafm.com 等）
    //   一律被拒，而 IP 字面量与放行命中根本不走这条分支，只看状态码的断言完全发现不了。
    //   改动这里请务必跑「主机名 + 不在放行名单」的用例（radio-harness 里有一条真实主机名用例）。
    // 对 IP 字面量（含 IPv6，方括号已在 radioHostOf 里去掉）它同样返回自身，所以这一条同时
    // 覆盖"域名"与"字面量"两种输入，不需要再引 net.isIP 分叉（少一条分支就少一处漏判）。
    addrs = await dns.promises.lookup(host, { all: true })
  } catch (err) {
    return radioResolveFailure(host, err)
  }
  if (!Array.isArray(addrs) || !addrs.length) return { status: 502, error: '域名无法解析' }
  // ⚠️ 必须看**全部**地址：只看第一条时，"第一条公网 + 第二条 127.0.0.1"的多 A 记录
  // 或 DNS rebinding 就能绕过。任一条命中即拒。
  for (const a of addrs) {
    const addr = a && a.address ? String(a.address) : ''
    const reason = a && Number(a.family) === 6 ? radioIpv6Rejection(addr) : radioIpv4Rejection(addr)
    if (reason) return { status: 403, error: reason }
  }
  return null
}

// DNS 解析失败时怎么答 —— 这里区分两件**性质完全不同**的事：
//   ① 正常解析不出来（ENOTFOUND / EAI_AGAIN / ENODATA…）：属于"上游不可达" → **502**。
//      以前这里回 403，用户与前端会把它读成"这台机器被回环限制"，排查方向整个被带偏。
//   ② `ERR_*`（Node 内部错误 / 参数类型错）= **我们自己代码写错**的编程错误：绝不能伪装成
//      "地址不安全"被静默 fail-closed —— 那会让真实故障看起来像安全拦截（本文件真踩过：
//      dns 回调式 API 用错 → 所有真实电台一致"域名无法解析"）→ **500** 并在宿主日志留痕。
// 两种情况都**不把** Node 内部错误码或原始英文 message 放进 `error`（用户看不懂、也容易被
// 当成电台本身的问题）；原始信息只进 console.warn，供排查用。
function radioResolveFailure(host, err) {
  const code = String((err && err.code) || '')
  try {
    console.warn('[whale-balance] 电台目标域名解析失败：host=' + host + ' code=' + (code || '(无)') + ' msg='
      + String((err && err.message) || err).replace(/[\r\n]+/g, ' ').slice(0, 200))
  } catch (warnErr) {}
  if (code.indexOf('ERR_') === 0) return { status: 500, error: '宿主解析上游地址失败（内部错误，详见宿主日志）' }
  return { status: 502, error: '域名无法解析' }
}

// —— 搜索：limit 归一（缺省 30 / 上限 50 / 非法值回落默认）——
function radioSearchLimit(raw) {
  const n = Number(String(raw === undefined || raw === null ? '' : raw).trim())
  if (!isFinite(n) || n <= 0) return RADIO_SEARCH_DEFAULT_LIMIT // 空 / abc / 0 / 负数都走这里
  return Math.min(Math.floor(n), RADIO_SEARCH_MAX_LIMIT)
}

// 上游 JSON 请求（SomaFM 频道表这类**单一地址**的上游）：统一 10s 整请求超时。
// 这里 follow 重定向是**安全**的：URL 由我们自己拼（用户输入只经 URLSearchParams 进查询串），
// 与 radio-stream 那条"用户直接给 URL"的路由完全不同，所以不需要手动逐跳。
// Radio Browser 不走这个函数 —— 它有镜像回退与更严的"可用"判据，见 radioFetchRbJson。
async function radioFetchJson(target) {
  const res = await fetch(target, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': RADIO_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(RADIO_JSON_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error('上游返回 HTTP ' + res.status)
  return await res.json()
}

// 本次进程内**第一个被证明可用**的 Radio Browser 镜像（后续搜索直接用它，不再重试坏镜像）。
// 初值：显式 BASE（若设了，离线端到端验证就是靠它指向桩）→ 否则镜像表第一个。
// 它同时是 radio.json 里 `sources.rb.base`（"生效的上游"）的来源。
let radioRbBase = RADIO_BROWSER_EXPLICIT || RADIO_BROWSER_MIRRORS[0] || ''
// 候选顺序：记住的 → 显式 → 镜像表（按 URL 去重，避免同一个镜像试两遍）
function radioRbCandidates() {
  const out = []
  for (const b of [radioRbBase, RADIO_BROWSER_EXPLICIT].concat(RADIO_BROWSER_MIRRORS)) {
    if (b && out.indexOf(b) < 0) out.push(b)
  }
  return out
}
// 探测"这个 Radio Browser 镜像真的能用"：判据刻意**严**（2xx + Content-Type 含 json +
// body 能 JSON.parse 成**数组**）。只判"HTTP 通了"是不够的 —— 本网络里
// api.radio-browser.info 会回 404 + text/html（一个普通网页），那是"通但不可用"。
async function radioFetchRbJson(url, timeoutMs) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': RADIO_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error('镜像返回 HTTP ' + res.status)
  const ctype = String(res.headers.get('content-type') || '').toLowerCase()
  if (ctype.indexOf('json') < 0) throw new Error('镜像返回的不是 JSON（' + (ctype.split(';')[0] || '无 Content-Type') + '）')
  const data = await res.json() // 坏 JSON 在这里抛，由调用方当作"这个镜像不可用"
  if (!Array.isArray(data)) throw new Error('镜像返回的 JSON 不是数组')
  return data
}

async function radioSearchRb(params) {
  const search = new URLSearchParams()
  search.set('hidebroken', 'true')
  search.set('order', 'votes')
  search.set('reverse', 'true')
  search.set('limit', String(params.limit))
  // q 为空时**不带** name：同一个接口在只有排序参数时返回的就是"票数最高的前 n 个"，
  // 所以"空查询 + tag/country"和"空查询 + 什么都没有"都不需要另走一条分支。
  if (params.q) search.set('name', params.q)
  if (params.country) search.set('countrycode', params.country)
  if (params.tag) search.set('tag', params.tag)
  const qs = search.toString()
  let last = ''
  // 总预算：每个镜像的单次超时取 min(6s, 剩余预算)，预算耗尽就不再试后面的候选
  const deadline = Date.now() + RADIO_BROWSER_TOTAL_BUDGET_MS
  for (const base of radioRbCandidates()) {
    const budgetLeft = deadline - Date.now()
    if (budgetLeft < 1500) { last = '总预算耗尽'; break }
    let data = null
    try {
      data = await radioFetchRbJson(base + '/json/stations/search?' + qs, Math.min(RADIO_BROWSER_PROBE_TIMEOUT_MS, budgetLeft))
    } catch (err) {
      last = String((err && err.message) || err)
      try {
        console.warn('[whale-balance] Radio Browser 镜像不可用，尝试下一个：' + base + ' —— ' + last.replace(/[\r\n]+/g, ' ').slice(0, 160))
      } catch (warnErr) {}
      continue
    }
    radioRbBase = base // 记住它：后续搜索直接从它开始
    const out = []
    for (const s of data) {
      if (!s || typeof s !== 'object') continue
      // url_resolved 才是最终直连地址（url 可能是个跳转页/播放器页），优先用它；
      // 两个都空的条目对播放毫无用处，直接丢掉（否则前端拿到一条点了没反应的电台）。
      const url = radioText(s.url_resolved || s.url || '', 2000).trim()
      if (!url) continue
      out.push(normalizeRadioStation({
        id: s.stationuuid,
        name: s.name,
        url: url,
        favicon: s.favicon,
        tags: s.tags,
        country: s.country,
        codec: s.codec,
        bitrate: s.bitrate,
        votes: s.votes,
      }, 'rb', true))
      if (out.length >= params.limit) break
    }
    return out
  }
  throw new Error('所有 Radio Browser 镜像都不可达')
}

// playlist 取舍：优先 mp3（浏览器 `<audio>` 对它支持最稳），同类里选 quality 最高的一条；
// 一个 mp3 都没有就取 quality 最高的第一条（至少还能播，总比"这个台搜得到点不开"好）。
function radioQualityRank(p) {
  const q = radioText(p && p.quality, 40).toLowerCase()
  const n = /(\d{2,4})/.exec(q)
  if (n) return Number(n[1])
  if (q.indexOf('highest') >= 0) return 1000
  if (q.indexOf('high') >= 0) return 500
  if (q.indexOf('medium') >= 0 || q.indexOf('mid') >= 0) return 250
  if (q.indexOf('low') >= 0) return 100
  return 0
}
// format → codec：`aacp`（HE-AAC）也算 aac；不认识的原样透出（总比编一个强）。
// **不从 URL 里猜编码**：SomaFM 的真实地址是 .pls，里面没有编码信息（只有 .pls 的内容才有）。
function radioCodecOf(format) {
  const f = radioText(format, 40).trim().toLowerCase()
  if (!f) return ''
  if (f.indexOf('mp3') >= 0) return 'mp3'
  if (f.indexOf('aac') >= 0) return 'aac'
  return f
}
// bitrate 的取值优先级（越靠前越准）：
//   ① quality 里的数字（`128k` 这类，桩与部分镜像会给）；
//   ② **播放列表 URL 自带的码率**：SomaFM 真实地址形如 `groovesalad256.pls` → 256、
//      `beatblender130.pls` → 130 —— 这是真实数据，比猜词准；
//   ③ quality 词映射（highest/high/medium/low）—— **近似值**，真实码率只有 .pls 里的
//      File1 才知道，但总比给前端一个 0（会显示成"0kbps"）好。
function radioBitrateOf(quality, url) {
  const qn = /(\d{2,4})/.exec(radioText(quality, 40))
  if (qn) return Number(qn[1])
  const un = /(\d{2,3})\.(?:pls|m3u8?)(?:[?#]|$)/i.exec(radioText(url, 2000))
  if (un) return Number(un[1])
  const q = radioText(quality, 40).toLowerCase()
  if (q.indexOf('highest') >= 0) return 256
  if (q.indexOf('high') >= 0) return 128
  if (q.indexOf('medium') >= 0 || q.indexOf('mid') >= 0) return 96
  if (q.indexOf('low') >= 0) return 64
  return 0
}
// codec / bitrate 都从 playlist 的 format/quality（以及 URL 里的码率数字）推出来
function radioSomafmPlaylist(playlists) {
  const list = Array.isArray(playlists)
    ? playlists.filter((p) => p && typeof p === 'object' && radioText(p.url, 2000).trim())
    : []
  if (!list.length) return null
  const ranked = list.slice().sort((a, b) => radioQualityRank(b) - radioQualityRank(a))
  const mp3 = ranked.filter((p) => radioText(p.format, 40).toLowerCase().indexOf('mp3') >= 0)
  const pick = mp3.length ? mp3[0] : ranked[0]
  const url = radioText(pick.url, 2000).trim()
  return { url: url, codec: radioCodecOf(pick.format), bitrate: radioBitrateOf(pick.quality, url) }
}
// SomaFM 的 image 字段可能是相对路径（/img/xxx.png）→ 用 channels.json 的地址补全；
// 不补的话前端 `<img src>` 会指向挂件自己那个源，图标必然 404。
function radioSomafmImage(ch) {
  const raw = radioText(ch && (ch.image || ch.largeimage || ch.xlimage), 1000).trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  try { return new URL(raw, SOMAFM_URL).toString() } catch (err) { return '' }
}

async function radioSearchSomafm(params) {
  const data = await radioFetchJson(SOMAFM_URL)
  const channels = data && Array.isArray(data.channels) ? data.channels : []
  const q = String(params.q || '').toLowerCase()
  const out = []
  for (const ch of channels) {
    if (!ch || typeof ch !== 'object') continue
    const id = radioText(ch.id, 120)
    const title = radioText(ch.title, 200)
    const desc = radioText(ch.description, 2000)
    const genre = radioText(ch.genre, 400)
    // q 为空 = 全部；否则在 title / description / genre / id 里做**不区分大小写**的包含匹配。
    // 刻意不做分词/模糊匹配：SomaFM 只有几十个台，一个子串匹配就够，模糊匹配只会给出
    // 用户看不懂的命中（而且本地化排序在 small-icu 上还可能抛）。
    if (q) {
      const hay = (title + '\n' + desc + '\n' + genre + '\n' + id).toLowerCase()
      if (hay.indexOf(q) < 0) continue
    }
    const pick = radioSomafmPlaylist(ch.playlists)
    if (!pick) continue
    out.push(normalizeRadioStation({
      id: id,
      name: title,
      url: pick.url,
      favicon: radioSomafmImage(ch),
      // tags 用 genre（前端只做截断显示）；个别频道没有 genre 时退回截断的 description，
      // 否则前端那一行会是空的。
      tags: genre || radioText(desc, 120),
      country: 'US',
      codec: pick.codec,
      bitrate: pick.bitrate,
    }, 'somafm', true))
    if (out.length >= params.limit) break
  }
  return out
}

// 带状态码的错误：让"哪一步失败 → 回哪个状态码"在一处决定（handler 里只做映射），
// 避免在深层函数里直接写响应（写了就再也改不了状态码，而且容易重复写）。
function radioHttpError(status, message) {
  const err = new Error(message)
  err.radioStatus = status
  return err
}
// 失败文案一律**可读中文**：这些字会直接显示在播放器的错误提示里。
// ⚠️ **绝不**把 Node/undici 的内部错误码或原始英文 message 透出去（ERR_* / EAI_* / "fetch failed" /
//    "getaddrinfo ENOTFOUND …"）：用户看不懂，而且会把"上游连不上"误读成电台或插件坏了。
//    我们自己的中文文案（"上游返回 HTTP 500"、"域名无法解析"…）原样放行；其余一律收敛成
//    "上游不可达"，原始信息只进宿主日志。
function radioErrText(err) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return '上游超时'
  const code = String((err && err.code) || (err && err.cause && err.cause.code) || '')
  const msg = String((err && err.message) || err || '').replace(/[\r\n]+/g, ' ').replace(/\s+$/, '').slice(0, 140)
  // 我们自己写的文案里可能夹着英文（如 "所有 Radio Browser 镜像都不可达"）⇒ 判"含中文"而不是
  // "以中文开头"，否则这类文案会被误收敛成"上游不可达"、丢掉真正的原因。
  if (/[\u3400-\u9fff]/.test(msg)) return msg
  try {
    console.warn('[whale-balance] 电台上游请求失败：code=' + (code || '(无)') + ' msg=' + msg.slice(0, 200))
  } catch (warnErr) {}
  return '上游不可达'
}
function radioStreamError(res, code, message) {
  try {
    res.writeHead(code, JSON_HEADERS)
    res.end(JSON.stringify({ ok: false, error: message }))
  } catch (err) {}
}

// 同时在转的流数量（上限 RADIO_MAX_STREAMS）。计数必须与**响应/连接的生命周期**绑定，
// 任何一条路径漏减都会让并发数只增不减，最后所有请求全 429（见 radioProxyStream 的 finally）。
let radioStreams = 0

// 按同一套 SSRF 管线取回一个上游响应：**逐跳手动跟随重定向，每一跳重新过
// radioTargetRejection**（含 DNS 解析后的范围判定）。返回 { up, url }。
// rangeHeader 只在"这已经是音频流本身"时传：播放列表是小文本文件，带 Range 只会被截断。
async function radioOpenUpstream(current, ac, rangeHeader) {
  let timer = null
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
  try {
    for (let hop = 0; ; hop++) {
      const bad = await radioTargetRejection(current)
      if (bad) throw radioHttpError(bad.status, bad.error)
      // ⚠️ Accept 的值刻意用拼接写：`*` + `/` + `*` 的**连写**会让 check-dead-settings.mjs
      //    那个粗暴的块注释剥离正则把它当成注释结束符，从而吃掉一大段代码并误报死键
      //（同一个坑在 music-file 的 416 Content-Range 那里已经踩过一次，见那里的注释）。
      const headers = { 'User-Agent': RADIO_UA, Accept: '*' + '/' + '*' }
      // 不少电台校验 Referer，缺了直接 403 —— 用目标自己的 origin 兜一个（不伪造别的站）
      try {
        const cu = new URL(current)
        headers.Referer = cu.protocol + '//' + cu.host + '/'
      } catch (err) {}
      if (rangeHeader) headers.Range = rangeHeader // 透传客户端 Range；没有/不该带就不带
      // 超时只覆盖"连接 + 首字节"：一旦响应头到手就撤掉计时器 ——
      // 电台是**无限流**，给整条流一个 15s 总超时等于"每次听到 15 秒就断"。
      timer = setTimeout(() => {
        try { ac.abort(radioHttpError(504, '上游超时')) } catch (err) {}
      }, RADIO_STREAM_TIMEOUT_MS)
      let up = null
      try {
        up = await fetch(current, {
          // 一律用 GET：HEAD 交给上游**不可靠**（有些 Icecast 直接 405），而 HEAD 预检要求
          // "状态码与 GET 一致" —— 用同一个方法取头，判定天然一致；HEAD 只是不写 body（见下）。
          method: 'GET',
          redirect: 'manual',
          headers: headers,
          signal: ac.signal,
        })
      } finally { clearTimer() }
      if (up.status >= 300 && up.status < 400) {
        const loc = up.headers.get('location')
        try { if (up.body) await up.body.cancel() } catch (err) {}
        if (!loc) throw radioHttpError(502, '上游返回了重定向但没有 Location')
        if (hop >= RADIO_STREAM_MAX_HOPS) throw radioHttpError(502, '上游重定向次数过多')
        try { current = new URL(loc, current).toString() } catch (err) {
          throw radioHttpError(502, '上游重定向地址无法解析')
        }
        continue
      }
      return { up: up, url: current }
    }
  } finally { clearTimer() }
}

// 读一小段文本（播放列表）：限长，读完**一定** cancel，别把上游连接挂在那里。
async function radioReadTextLimited(up, maxBytes) {
  if (!up.body) return ''
  const reader = up.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const c = await reader.read()
      if (c.done) break
      if (!c.value || !c.value.length) continue
      size += c.value.length
      if (size > maxBytes) throw new Error('playlist too large')
      chunks.push(Buffer.from(c.value))
    }
  } finally {
    try { await reader.cancel() } catch (err) {}
  }
  return Buffer.concat(chunks).toString('utf8')
}

// —— 音频流代理 ——
// 为什么必须有代理而不是让前端直接 `<audio src=上游>`：
//   ① 上游多半不带 CORS 头，跨源会被浏览器拦；② 不少电台校验 Referer/UA；
//   ③ https 页面放 http 电台会被"混合内容"拦掉 —— 经宿主的同源 http 中转才都能放。
// 代价是这条路由会**替调用方**发请求，所以它同时是攻击面：SSRF、Content-Type 白名单、
// 手动逐跳重定向、连接数上限，四道防护都在这里。
// ⚠️ **播放列表要先解引用**：SomaFM 给的就是 `.pls`（`https://api.somafm.com/groovesalad256.pls`），
//    直接把它的响应流给 `<audio>` 会得到一段文本 —— 用户看到"正在播放"却没有任何声音。
//    所以顺序是「**先判播放列表 → 解析成真流 → 再代理**」，而不是"白名单不通过就拒"。
//    headOnly（HEAD 预检）：走完全同一套判定，但不写 body（前端只用状态码/头）。
async function radioProxyStream(req, res, target, ac, headOnly) {
  const clientRange = req.headers && typeof req.headers.range === 'string' && req.headers.range
    ? req.headers.range : ''
  let current = target
  let playlistDepth = 0
  for (;;) {
    // 这次要不要带 Range：目标看着像播放列表就不带（小文本文件被 Range 截断没有意义）
    const opened = await radioOpenUpstream(current, ac, radioPlaylistPathOf(current) ? '' : clientRange)
    const up = opened.up
    const ctype = up.headers.get('content-type')
    const playlistKind = radioPlaylistKind(opened.url, ctype)
    if (playlistKind) {
      if (playlistDepth >= RADIO_PLAYLIST_MAX_DEPTH) {
        try { if (up.body) await up.body.cancel() } catch (err) {}
        throw radioHttpError(502, '上游播放列表嵌套层数过多')
      }
      let text = ''
      try {
        text = await radioReadTextLimited(up, RADIO_PLAYLIST_MAX_BYTES)
      } catch (err) {
        throw radioHttpError(502, '上游播放列表读取失败')
      }
      const next = radioParsePlaylist(text, opened.url, playlistKind)
      if (!next) throw radioHttpError(502, '上游播放列表里没有可用地址')
      // 解出来的地址**会再完整过一遍** SSRF（下一轮 radioOpenUpstream 的第一件事），
      // 所以"播放列表指向 127.0.0.1"这类绕过同样会被拒。
      current = next
      playlistDepth++
      continue
    }
    // Content-Type 白名单：过了这一关才允许把上游字节交给页面
    //（播放列表类在这里也会被拒 —— 兜底 fail-closed，正常路径上已经在上面的分支处理掉了）
    const typeReason = radioStreamTypeRejection(ctype)
    if (typeReason) {
      try { if (up.body) await up.body.cancel() } catch (err) {}
      throw radioHttpError(502, typeReason)
    }
    const out = { 'Cache-Control': 'no-store' }
    const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges',
      'icy-name', 'icy-genre', 'icy-br', 'icy-description']
    const encoding = up.headers.get('content-encoding')
    for (const name of passthrough) {
      const v = up.headers.get(name)
      if (v === undefined || v === null || v === '') continue
      // undici 会自动解压 gzip/br：此时 body 已经不是原始字节，再透传 Content-Length
      // 会让浏览器按错误的长度截断或挂住 —— 这种情况丢掉长度，交给 chunked。
      if (name === 'content-length' && encoding && encoding !== 'identity') continue
      out[name] = v
    }
    res.writeHead(up.status, out) // 200/206 原样透传
    res.on('error', () => {}) // 客户端中途断开时 res 上的错误不该冒到宿主
    // HEAD 预检：状态码/响应头与 GET 完全一致，但**不写 body**、也不把上游流拉下来
    if (headOnly) {
      try { if (up.body) await up.body.cancel() } catch (err) {}
      try { res.end() } catch (err) {}
      return
    }
    // 流式转发：**绝不**把整个响应读进内存（电台是无限流，arrayBuffer() 永远不会返回）
    if (!up.body) { try { res.end() } catch (err) {} return }
    const reader = up.body.getReader()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (!chunk.value || !chunk.value.length) continue
        if (!res.write(Buffer.from(chunk.value))) {
          // 背压：等 drain 再继续读上游，否则内存里会堆满没人要的音频
          await new Promise((resolve) => {
            res.once('drain', resolve)
            res.once('close', resolve) // 客户端断开时也要放行，否则这里永远挂着
          })
        }
      }
    } finally {
      try { await reader.cancel() } catch (err) {}
    }
    try { res.end() } catch (err) {}
    return
  }
}

// —— 电台接口 ①：收藏 / 上次来源（GET）+ 三种 action（POST）——
// 与 music.json 同构：GET 与 POST 成功时返回**同一个形状**（radioPayload()）。
// 写请求的"必须来自本机（回环）"判断不在这个 handler 里：registerRoute() → writeRejection()
// 已经先跑过一遍，非回环的 POST 在进到这里之前就 403 了。
registerRoute({
  kind: 'exact',
  path: '/dsh-whale/radio.json',
  handler: async (req, res) => {
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        // 收藏只是几条元数据，body 很小：8KB 足够，顺带挡住"拿这条接口灌大 body"。
        const body = await readBodyMax(req, 8 * 1024)
        const parsed = JSON.parse(body)
        const action = String((parsed && parsed.action) || '')
        const state = readRadioState()
        if (action === 'add-favorite') {
          const station = normalizeRadioStation((parsed && parsed.station) || {}, (parsed && parsed.station && parsed.station.source), false)
          // url 必须是 http/https（与 radio-stream 的第一道检查同口径）：
          // 收藏一个 `file:` / `data:` 地址只会变成"点了永远播不出来"的僵尸条目。
          if (!/^https?:\/\/[^\s]+$/i.test(station.url)) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '收藏的电台地址必须是 http/https' }))
            return
          }
          const at = state.favorites.findIndex((f) => f.url === station.url)
          if (at >= 0) {
            // 按 url 去重：已存在就**更新**名称/标签等字段（用户重收藏一次是想刷新信息），
            // 而不是再加一条 —— 否则列表里会出现两个一模一样的台。
            state.favorites[at] = station
          } else {
            if (state.favorites.length >= RADIO_MAX_FAVORITES) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: '收藏已达上限 ' + RADIO_MAX_FAVORITES + ' 个' }))
              return
            }
            state.favorites.push(station)
          }
          writeRadioState(state)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(radioPayload()))
          return
        }
        if (action === 'remove-favorite') {
          const url = radioText(parsed && parsed.url, 2000)
          // 不存在也返回 200：这个动作的语义是"让它不在收藏里"，已经是目标状态了
          state.favorites = state.favorites.filter((f) => f.url !== url)
          writeRadioState(state)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(radioPayload()))
          return
        }
        if (action === 'set-source') {
          const src = String((parsed && parsed.source) || '')
          if (src !== 'rb' && src !== 'somafm') {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'source 只能是 rb 或 somafm' }))
            return
          }
          state.lastSource = src
          writeRadioState(state)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(radioPayload()))
          return
        }
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
      return
    }
    // GET：收藏 + 上次来源 + 生效的上游 + 上限，一次拿齐
    try {
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(radioPayload()))
    } catch (err) {
      res.writeHead(500, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
    }
  },
})

// —— 电台接口 ②：搜索（**仅回环**）——
// 上游失败 / 超时 / JSON 坏 → 502 + {ok:false,error}（不抛：抛出去宿主回 500，
// 前端只能看到"服务器错误"，而用户需要知道是"搜索源连不上"）。
registerRoute({
  kind: 'exact',
  path: '/dsh-whale/radio-search',
  handler: async (req, res) => {
    if (radioLoopbackRejection(req, res)) return
    let source = 'rb'
    let query = ''
    let country = ''
    let tag = ''
    let limit = RADIO_SEARCH_DEFAULT_LIMIT
    try {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1')
      const params = u.searchParams
      // source **只接受** rb / somafm：传了别的值一律 400，而不是静默回落成 rb ——
      // 静默回落会让"客户端把来源拼错"变成"搜索结果来自另一条上游"且毫无提示。
      // 参数**缺省/为空**仍按默认源 rb：宿主与前端是两个可以版本不同步的文件（前端靠硬刷新
      // 更新），老前端不带这个参数时不该整条搜索直接失效。
      const rawSource = params.get('source')
      if (rawSource !== null && rawSource !== '') {
        if (rawSource !== 'rb' && rawSource !== 'somafm') {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'source 只能是 rb 或 somafm' }))
          return
        }
        source = rawSource
      }
      // 各字段都限长：它们会被拼进上游查询串（URLSearchParams 会编码，但长度还是要管）
      query = radioText(params.get('q'), 120).trim()
      country = radioText(params.get('country'), 8).trim()
      tag = radioText(params.get('tag'), 60).trim()
      limit = radioSearchLimit(params.get('limit'))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: '查询参数无法解析' }))
      return
    }
    try {
      const stations = source === 'somafm'
        ? await radioSearchSomafm({ q: query, limit: limit })
        : await radioSearchRb({ q: query, country: country, tag: tag, limit: limit })
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: true, source: source, query: query, stations: stations }))
    } catch (err) {
      try {
        res.writeHead(502, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: radioErrText(err) }))
      } catch (e2) {}
    }
  },
})

// —— 电台接口 ③：音频流代理（**仅回环**）——
// u=<encodeURIComponent(上游地址)>。四道防护（SSRF / Content-Type 白名单 / 逐跳重定向
// / 并发上限）的实现与理由都在 radioProxyStream 与 radioTargetRejection 上。
// **HEAD 也支持**：前端会用一次 HEAD 预检来拿状态码（429/502/403），判定与 GET 完全同源，
// 只是不写 body（HEAD 不能有 body；前端用状态码映射文案）。
registerRoute({
  kind: 'exact',
  path: '/dsh-whale/radio-stream',
  handler: async (req, res) => {
    if (radioLoopbackRejection(req, res)) return
    const method = String((req && req.method) || 'GET').toUpperCase()
    const headOnly = method === 'HEAD'
    let target = ''
    try {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1')
      target = String(u.searchParams.get('u') || '').trim() // searchParams.get 已自动解码
    } catch (err) { target = '' }
    if (!target) {
      radioStreamError(res, 400, '缺少 u 参数（要播放的电台地址）')
      return
    }
    // 并发闸门：**先占坑再发请求**（超过上限立刻 429，别让上游连接先建起来）；
    // 计数在 finally 里释放，客户端中途断开 / 上游失败 / 正常播完都走同一条路径。
    // HEAD 预检同样占坑（否则预检期间并发已经满了，预检却报 200 —— 状态码就不一致了）。
    if (radioStreams >= RADIO_MAX_STREAMS) {
      radioStreamError(res, 429, '同时播放的在线流过多')
      return
    }
    radioStreams++
    let released = false
    const release = () => { if (!released) { released = true; radioStreams-- } }
    // 客户端断开（关页面 / 暂停后取消 / 切台）时必须 abort 上游：否则宿主会一直挂着那条
    // 上游连接读一个没人要的无限流 —— 每切一次台泄漏一条，几分钟就把连接和并发计数耗光。
    const ac = new AbortController()
    const onClientGone = () => { try { ac.abort() } catch (err) {} }
    req.on('close', onClientGone)
    req.on('aborted', onClientGone)
    res.on('close', onClientGone)
    try {
      await radioProxyStream(req, res, target, ac, headOnly)
    } catch (err) {
      // 已经发过头（音频流播到一半断了）就什么都不能再写，交给客户端自己收尾
      if (!res.headersSent) {
        // HEAD 的失败响应也只有状态码（不能有 body）—— 前端按状态码映射文案即可
        radioStreamError(res, Number(err && err.radioStatus) || 502, headOnly ? '' : radioErrText(err))
      }
    } finally {
      release()
      req.removeListener('close', onClientGone)
      req.removeListener('aborted', onClientGone)
      res.removeListener('close', onClientGone)
    }
  },
})
  return { routes: registered.slice() }
}
