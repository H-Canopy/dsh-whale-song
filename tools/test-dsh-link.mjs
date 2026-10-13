import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startPetServer } from '../desktop/standalone/server.mjs'

const require = createRequire(import.meta.url)
const { createDshLink, loopbackBase } = require('../desktop/standalone/dsh-link.cjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-link-'))
let token = 'a'.repeat(32)
let online = true
let stateRequests = 0
const controls = []
const sockets = new Set()
const mock = http.createServer(async (req, res) => {
  if (req.headers['x-dsh-pet-desk'] !== token) { res.writeHead(401); res.end(); return }
  const pathname = new URL(req.url, 'http://localhost').pathname
  if (pathname === '/dsh-pet/state') {
    stateRequests++
    if (!online) { res.writeHead(503); res.end(); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, status: 'thinking', desktop: true, sessionId: 'integration-test' }))
  } else if (pathname === '/dsh-pet/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"t":"hello","status":"thinking"}\n\n')
    req.on('close', () => res.end())
  } else if (pathname === '/dsh-pet/say') {
    let body = ''
    for await (const chunk of req) body += chunk
    controls.push({ body: JSON.parse(body), cookie: req.headers.cookie })
    res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}')
  } else if (pathname === '/dsh-whale/music-file') {
    res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 1-2/4', 'Content-Length': '2' })
    res.end('bc')
  } else { res.writeHead(404); res.end() }
})
mock.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + mock.address().port
const ticket = () => fs.writeFileSync(path.join(home, 'dsh-live2d-pet-desktop.json'), JSON.stringify({ port: mock.address().port, token }))
ticket()
let pref = 'auto'
const link = createDshLink({ home, bases: [base], preference: () => pref })
const service = await startPetServer({ repoRoot: root, dshLink: link, ownerPath: '/dsh-pet/owner/test', ownerActive: () => true })
let pass = 0
async function test(name, fn) { await fn(); pass++; console.log('  ok ' + name) }
try {
  await test('loopback validation refuses remote addresses, credentials, paths and alternate protocols', () => {
    assert.equal(loopbackBase(base), base)
    for (const value of ['https://127.0.0.1:100', 'http://example.com:100', 'http://u:p@127.0.0.1:100', base + '/private']) assert.equal(loopbackBase(value), null)
  })
  await test('offline mode renders without claiming the DSH page', async () => {
    assert.equal((await (await fetch(service.petBase + '/dsh-pet/state')).json()).standalone, true)
    assert.equal((await (await fetch(service.petBase + '/dsh-pet/owner/test')).json()).active, false)
  })
  const before = await fetch(service.petBase + '/dsh-pet/events')
  const reader = before.body.getReader()
  await reader.read()
  await test('connection authenticates to DSH and closes the offline event stream for reconnection', async () => {
    await link.refresh(); assert.equal(link.status().connected, true)
    assert.equal((await reader.read()).done, true)
    assert.equal((await (await fetch(service.petBase + '/dsh-pet/state')).json()).sessionId, 'integration-test')
  })
  await test('upstream SSE reaches the same desktop origin', async () => {
    const response = await fetch(service.petBase + '/dsh-pet/events')
    const stream = response.body.getReader()
    const event = await stream.read()
    assert.match(new TextDecoder().decode(event.value), /thinking/)
    await stream.cancel()
  })
  await test('POST body reaches DSH exactly once without forwarding browser cookies', async () => {
    const response = await fetch(service.petBase + '/dsh-pet/say', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'foreign=secret' }, body: JSON.stringify({ text: '你好，桌宠' }) })
    assert.equal(response.status, 200)
    assert.equal(controls.length, 1); assert.equal(controls[0].body.text, '你好，桌宠'); assert.equal(controls[0].cookie, undefined)
  })
  await test('audio range and response headers pass through for seeking', async () => {
    const response = await fetch(service.petBase + '/dsh-whale/music-file?id=test', { headers: { Range: 'bytes=1-2' } })
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 1-2/4'); assert.equal(await response.text(), 'bc')
  })
  await test('only the connected DSH origin can read the ownership lease', async () => {
    const yes = await fetch(service.petBase + '/dsh-pet/owner/test', { headers: { Origin: base } })
    assert.equal(yes.headers.get('access-control-allow-origin'), base); assert.equal((await yes.json()).active, true)
    assert.equal((await fetch(service.petBase + '/dsh-pet/owner/test', { headers: { Origin: 'https://evil.example' } })).status, 403)
  })
  await test('official DSH Desktop custom origin and read-only private-network preflight work', async () => {
    const desktop = await fetch(service.petBase + '/dsh-pet/owner/test', { headers: { Origin: 'dsh-app://app' } })
    assert.equal(desktop.headers.get('access-control-allow-origin'), 'dsh-app://app')
    assert.equal((await desktop.json()).active, true)
    const preflight = await fetch(service.petBase + '/dsh-pet/owner/test', { method: 'OPTIONS', headers: {
      Origin: 'dsh-app://app', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true',
    } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true')
    assert.equal((await fetch(service.petBase + '/dsh-pet/owner/test', { method: 'OPTIONS', headers: {
      Origin: 'dsh-app://app', 'Access-Control-Request-Method': 'POST',
    } })).status, 403)
  })
  await test('cross-site control and arbitrary proxy destinations are refused', async () => {
    const response = await fetch(service.petBase + '/dsh-pet/say', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })
    assert.equal(response.status, 403); assert.equal(controls.length, 1)
    assert.equal((await fetch(service.petBase + '/admin')).status, 404)
    const badHost = await new Promise((resolve, reject) => {
      http.get(service.petBase + '/dsh-pet/state', { headers: { Host: 'evil.example' } }, (res) => {
        res.resume(); resolve(res.statusCode)
      }).on('error', reject)
    })
    assert.equal(badHost, 403)
  })
  await test('token rotation reconnects after rereading the local ticket', async () => {
    token = 'b'.repeat(32); ticket(); await link.refresh()
    assert.equal((await fetch(service.petBase + '/dsh-pet/state')).status, 200)
  })
  await test('host preference is honored instead of silently connecting to a different profile', async () => {
    pref = 'web'; await link.refresh(); assert.equal(link.status().connected, false)
    pref = 'desktop'; await link.refresh(); assert.equal(link.status().connected, true)
  })
  await test('DSH failure restores offline mode and releases the ownership lease', async () => {
    online = false; await link.refresh()
    assert.equal(link.status().connected, false)
    assert.equal((await (await fetch(service.petBase + '/dsh-pet/owner/test')).json()).active, false)
    assert.equal((await (await fetch(service.petBase + '/dsh-pet/state')).json()).standalone, true)
    online = true; await link.refresh(); assert.equal(link.status().connected, true)
  })
  assert(stateRequests >= 6)
  console.log('结果：pass ' + pass + ' / fail 0')
} finally {
  link.close(); service.close(); mock.close(); for (const socket of sockets) socket.destroy()
  fs.rmSync(home, { recursive: true, force: true })
}
