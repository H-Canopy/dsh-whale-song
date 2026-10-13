// Real Chromium test: only one renderer owns the pet, with automatic fallback after shell exit/crash.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startPetServer } from '../desktop/standalone/server.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const browser = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].filter(Boolean).find(fs.existsSync)
if (!browser) throw new Error('Chromium is required for the ownership acceptance test')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-owner-browser-'))
let active = true
let hostBase = null
const fakeLink = { status: () => ({ connected: true, base: hostBase }), onChange: () => () => {}, forward: () => false }
const owner = await startPetServer({ repoRoot: root, dshLink: fakeLink, ownerPath: '/dsh-pet/owner/abc123', ownerActive: () => active })
const hostLink = {
  status: () => ({ connected: false, base: null }), onChange: () => () => {},
  forward: (req, res) => {
    if (req.url !== '/dsh-pet/config') return false
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ enabled: true, desktopEndpoint: owner.petBase + '/dsh-pet/owner/abc123' }))
    return true
  },
}
const host = await startPetServer({ repoRoot: root, dshLink: hostLink })
hostBase = host.petBase
const child = spawn(browser, ['--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--remote-debugging-port=0', '--user-data-dir=' + temp, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
let ws
let pass = 0
try {
  let debugPort
  for (let i = 0; i < 80 && !debugPort; i++) {
    try { debugPort = Number(fs.readFileSync(path.join(temp, 'DevToolsActivePort'), 'utf8').split('\n')[0]) } catch {}
    if (!debugPort) await sleep(100)
  }
  if (!debugPort) throw new Error('Browser did not start')
  const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()
  ws = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => { const data = JSON.parse(String(event.data)); if (pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id) } })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const request = ++id
    const timer = setTimeout(() => { pending.delete(request); reject(new Error('CDP timeout: ' + method)) }, 15000)
    pending.set(request, (data) => { clearTimeout(timer); data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result) })
    ws.send(JSON.stringify({ id: request, method, params }))
  })
  const ev = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  const waitFor = async (expression) => {
    for (let i = 0; i < 100; i++) { if (await ev(expression)) return; await sleep(150) }
    throw new Error('Condition failed: ' + expression)
  }
  const check = (name, condition) => { assert(condition, name); pass++; console.log('  ok ' + name) }
  await send('Page.navigate', { url: host.petBase + '/dsh-pet/app' })
  await waitFor('window.__DSH_DESKTOP_OWNED__ === true')
  check('DSH page does not create a second model while the desktop owns it', await ev('!document.querySelector(".dshp-root") && !DSHPet.state.modelSize'))
  active = false
  await waitFor('window.__DSH_DESKTOP_OWNED__ === false && !!DSHPet.state.modelSize && !!DSHPet.inputSnapshot()')
  check('DSH page renders the pet when the desktop releases ownership', await ev('!window.__DSHPetError && getComputedStyle(document.querySelector(".dshp-root")).display !== "none"'))
  active = true
  await waitFor('window.__DSH_DESKTOP_OWNED__ === true')
  check('desktop reconnect hides the existing DSH model', await ev('getComputedStyle(document.querySelector(".dshp-root")).display === "none"'))
  owner.close()
  await waitFor('window.__DSH_DESKTOP_OWNED__ === false')
  check('a crashed shell with a stale config endpoint cannot leave the pet hidden', await ev('getComputedStyle(document.querySelector(".dshp-root")).display !== "none" && !!DSHPet.inputSnapshot()'))
  console.log('结果：pass ' + pass + ' / fail 0')
} finally {
  if (ws) ws.close()
  owner.close(); host.close()
  child.kill()
  await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 2000) } })
  // Chromium descendants may briefly retain files on Windows; preserve temp if still locked.
  try { fs.rmSync(temp, { recursive: true, force: true }) } catch {}
}
