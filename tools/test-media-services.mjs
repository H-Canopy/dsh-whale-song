// ============================================================================
// test-media-services.mjs —— 本地音乐/电台服务搬迁的接线测试（不需要 DSH / 不需要放歌）
// ----------------------------------------------------------------------------
// 外部那两套验收 harness（whale-widget-patch-tests 下的 music-harness.mjs / radio-harness.mjs）
// 是**最终**验收标准（43 / 52 条），但它们不在本仓库里、CI 跑不到。所以这里用仓内的方式把
// "搬迁真的接上了"锁住：
//   · 五条 /dsh-whale/* 路由确实由 lib/index.js 注册（走真 host、真 HTTP，不桩任何东西）
//   · 信任栅栏真的在：伪造 Host 的写请求 → 403，回环 Host → 放行
//   · music.json / music-file 的基本行为（歌单形状、Range、目录穿越）
// 电台的 SSRF / 回环 / 并发那 30 多条的**细节**仍然只看外部 harness（这里不重复抄一遍）。
//
// 跑：node tools/test-media-services.mjs
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  ok   ' + msg) }
  else { fail++; failures.push(msg); console.log('  FAIL ' + msg + (detail === undefined ? '' : '  → ' + detail)) }
}

// 隔离的 DSH_HOME + 一个托管目录里的测试音频（与 music-harness 同口径：内容是随机字节，
// 被测的是 Range 语义而不是音频本身）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-media-services-'))
const DSH_HOME = path.join(TMP, 'dsh-home')
const MANAGED = path.join(DSH_HOME, 'whale-music')
fs.mkdirSync(MANAGED, { recursive: true })
const AUDIO = crypto.randomBytes(2048)
fs.writeFileSync(path.join(MANAGED, 'track.mp3'), AUDIO)
fs.writeFileSync(path.join(MANAGED, 'notes.txt'), 'not audio')
process.env.DSH_HOME = DSH_HOME

const routes = []
const ctx = {
  webServer: { port: 1, register(r) { routes.push(r); return () => {} }, tapIndex() { return () => {} } },
  connection: undefined,         // 复刻"宿主栅栏不可用"的环境（媒体服务要自己扛住）
  effect(fn) { return fn() },
  get(n) { return n === 'connection' ? undefined : undefined },
  on() {},
  logger: console,
}
const plugin = (await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)).default
plugin.apply(ctx)

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  const r = routes.find((x) => (x.kind === 'prefix' ? pathname.startsWith(x.path) : x.path === pathname))
  if (!r) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no-route'); return }
  Promise.resolve().then(() => r.handler(req, res)).catch((err) => {
    try { res.writeHead(500).end('handler-error: ' + err.message) } catch (e) {}
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const HOST = '127.0.0.1:' + PORT

function request(method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: Object.assign({ Host: HOST }, headers) }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', (err) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), netError: err.code }))
    if (body) req.write(body)
    req.end()
  })
}
const getJson = async (p) => { const r = await request('GET', p); let j = null; try { j = JSON.parse(r.body.toString('utf8')) } catch (e) {} return Object.assign(r, { json: j }) }
const postJson = (p, obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  return request('POST', p, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) }, body })
}

console.log('\n--- 路由是否由宿主注册上 ---')
for (const p of ['/dsh-whale/music.json', '/dsh-whale/music-file', '/dsh-whale/radio.json', '/dsh-whale/radio-search', '/dsh-whale/radio-stream']) {
  const found = routes.find((r) => r.path === p)
  if (!found) ok(false, '注册了 ' + p, '没注册')
}
ok(routes.filter((r) => r.path.startsWith('/dsh-whale/')).length === 5, '五条 /dsh-whale/* 路由都在（路径沿用挂件的，外部 harness 按它写死）',
  routes.filter((r) => r.path.startsWith('/dsh-whale/')).map((r) => r.path).join(','))
ok(routes.some((r) => r.path === '/dsh-pet/media'), '我们自己的 /dsh-pet/media 没被挤掉', '')

console.log('\n--- 信任栅栏（安全边界不能外包给调用方）---')
{
  const post = Buffer.from(JSON.stringify({ action: 'set-settings', settings: { volume: 0.1 } }), 'utf8')
  const evil = await request('POST', '/dsh-whale/music.json', {
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(post.length), Host: 'evil.example.com' }, body: post,
  })
  ok(evil.status === 403, '伪造 Host 的写请求 → 403', 'status=' + evil.status)
  const after = (await getJson('/dsh-whale/music.json')).json
  ok(after && after.settings && after.settings.volume !== 0.1, '伪造 Host 的写入没有生效', 'volume=' + (after && after.settings && after.settings.volume))
  const crossSite = await request('GET', '/dsh-whale/music.json', { headers: { 'Sec-Fetch-Site': 'cross-site' } })
  ok(crossSite.status === 403, 'Sec-Fetch-Site: cross-site → 403', 'status=' + crossSite.status)
  // "缺 Host"要用裸 socket 发才测得出来：Node 的 http 客户端会把空 Host 按 URL 补回去（补成
  // 127.0.0.1:PORT），所以走 http.request 测的其实是"有 Host"。这里直接发一行畸形 Host。
  const raw = await new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => {
      s.write('GET /dsh-whale/music.json HTTP/1.1\r\nHost: [::\r\nConnection: close\r\n\r\n')
    })
    let buf = ''
    s.on('data', (d) => { buf += d.toString('utf8') })
    s.on('close', () => resolve(buf))
    s.on('error', () => resolve(''))
  })
  ok(/^HTTP\/1\.1 403/.test(raw), '畸形 Host（裸 socket 发）→ 403（fail-closed）', raw.split('\r\n')[0] || '(空)')
  const badOrigin = await request('GET', '/dsh-whale/music.json', { headers: { Origin: 'http://evil.example.com' } })
  ok(badOrigin.status === 403, 'Origin 与 Host 不同源 → 403', 'status=' + badOrigin.status)
}

console.log('\n--- 电台三条路由只认回环 ---')
for (const p of ['/dsh-whale/radio.json', '/dsh-whale/radio-search?source=rb&q=x', '/dsh-whale/radio-stream?u=' + encodeURIComponent('http://example.com/a')]) {
  const r = await request('GET', p, { headers: { Host: 'evil.example.com:80' } })
  if (r.status !== 403) ok(false, '非回环访问 ' + p + ' → 403', 'status=' + r.status)
}
ok(true, 'radio.json / radio-search / radio-stream：非回环一律 403')

console.log('\n--- 本地音乐：歌单与音频 ---')
let listPayload = null
{
  const r = await getJson('/dsh-whale/music.json')
  listPayload = r.json
  ok(r.status === 200 && r.json && r.json.ok === true, 'GET music.json → 200 JSON', 'status=' + r.status)
  const tracks = (r.json && r.json.tracks) || []
  ok(tracks.length === 1 && tracks[0].name === 'track.mp3', '扫描到托管目录里的 1 个音频（.txt 被排除）', tracks.map((t) => t.name).join(','))
  ok(tracks.every((t) => t.id && t.name && t.ext && t.size > 0 && String(t.url).indexOf('/dsh-whale/music-file?id=') === 0),
    '每条 track 带 id/name/ext/size/url', JSON.stringify(tracks[0] || null))
}
{
  const t = (listPayload.tracks || [])[0]
  const full = await request('GET', t.url)
  ok(full.status === 200 && full.body.equals(AUDIO), '音频：无 Range → 完整字节', 'status=' + full.status + ' bytes=' + full.body.length)
  const mid = await request('GET', t.url, { headers: { Range: 'bytes=10-19' } })
  ok(mid.status === 206 && mid.body.equals(AUDIO.subarray(10, 20)) && mid.headers['content-range'] === 'bytes 10-19/' + AUDIO.length,
    '音频：Range → 206 + 正确字节 + Content-Range', mid.status + ' ' + mid.headers['content-range'])
  const bad = await request('GET', t.url, { headers: { Range: 'bytes=999999-' } })
  ok(bad.status === 416, '音频：起点越界 → 416', 'status=' + bad.status)
  const trav = await request('GET', '/dsh-whale/music-file?id=' + encodeURIComponent('../../../../Windows/win.ini'))
  ok(trav.status === 404, '目录穿越 id → 404', 'status=' + trav.status)
}

console.log('\n--- 状态文件落在 $DSH_HOME（换插件不丢歌单）---')
{
  await postJson('/dsh-whale/music.json', { action: 'set-settings', settings: { volume: 0.42, loop: 'one' } })
  ok(fs.existsSync(path.join(DSH_HOME, '.dshw-music.json')), '写了 $DSH_HOME/.dshw-music.json', DSH_HOME)
  const after = (await getJson('/dsh-whale/music.json')).json
  ok(after.settings.volume === 0.42 && after.settings.loop === 'one', '设置已持久化', JSON.stringify(after.settings))
}

await new Promise((r) => server.close(r))
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (err) {}

console.log('\n结果：pass ' + pass + ' / fail ' + fail)
if (fail && failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail ? 1 : 0)
