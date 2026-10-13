// Exercise the actual generated Electron entry point with isolated filesystem and native-window doubles.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHELL = path.join(ROOT, 'desktop', 'standalone')
const { clampWindow, beginDrag, advanceDrag, savedPosition, restorePosition } = require(path.join(SHELL, 'window-state.cjs'))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-window-'))
const userData = path.join(temp, 'userData')
const home = path.join(temp, 'dsh')
fs.mkdirSync(userData); fs.mkdirSync(home)
fs.writeFileSync(path.join(home, 'dsh-live2d-pet.json'), JSON.stringify({ height: 180, lookAtCursor: false }))
fs.writeFileSync(path.join(userData, 'pos.json'), JSON.stringify([100, 150]))
let pass = 0
function test(name, fn) { fn(); pass++; console.log('  ok ' + name) }
const a = [{ x: 0, y: 0, width: 1920, height: 1040 }]
const body = { x: 170, y: 340, w: 200, h: 200 }
test('drag consumes relative movement, including vertical movement', () => {
  const drag = beginDrag({ x: 500, y: 300, width: 420, height: 600 })
  assert.deepEqual(advanceDrag(drag, 20, 40, body, a), { x: 520, y: 340, width: 420, height: 600 })
  assert.deepEqual(advanceDrag(drag, 30, 44, body, a), { x: 530, y: 344, width: 420, height: 600 })
})
test('returning from a clamped edge reacts immediately', () => {
  const drag = beginDrag({ x: 1400, y: 300, width: 420, height: 600 })
  const atEdge = advanceDrag(drag, 500, 0, body, a)
  const returned = advanceDrag(drag, 490, 0, body, a)
  assert.equal(returned.x, atEdge.x - 10)
})
test('zero delta and malformed delta cannot move the pet', () => {
  const drag = beginDrag({ x: 500, y: 300, width: 420, height: 600 })
  assert.equal(advanceDrag(drag, 0, 0, body, a).x, 500)
  assert.equal(advanceDrag(drag, NaN, 0, body, a), null)
})
test('second monitor with a negative origin remains reachable', () => {
  const result = clampWindow({ x: -900, y: 100 }, body, [{ x: -1920, y: 0, width: 1920, height: 1080 }, ...a])
  assert.equal(result.x, -900)
})
test('position round-trip preserves the model anchor after canvas size changes', () => {
  const saved = savedPosition({ x: 500, y: 300 }, body, a)
  assert.deepEqual(restorePosition(saved, { ...body, x: 190, y: 360 }, a, { x: 0, y: 0 }), { x: 480, y: 280 })
})
test('changed resolution and unplugged monitors restore a visible position', () => {
  const saved = savedPosition({ x: 1000, y: 300 }, body, a)
  const smaller = [{ x: 0, y: 0, width: 1280, height: 720 }]
  const p = restorePosition(saved, body, smaller, { x: 0, y: 0 })
  assert(p.x + body.x >= 8 && p.x + body.x + body.w <= 1272)
  assert(p.y + body.y >= 8 && p.y + body.y + body.h <= 712)
  assert.equal(restorePosition([NaN, 200], body, a, { x: 500, y: 300 }).x, 500)
})

const events = new Map()
const ipc = new Map()
const intervals = []
const nativeCalls = []
const windows = []
let cursor = { x: 0, y: 0 }
let now = Date.now()
const fakeDate = class extends Date { static now() { return now } }
const app = {
  setName() {}, setAppUserModelId() {}, getPath: () => userData,
  on: (name, fn) => events.set(name, fn), whenReady: async () => {}, requestSingleInstanceLock: () => true,
  quit: () => { nativeCalls.push(['quit']) },
}
class FakeWindow {
  constructor(options) {
    this.options = options; this.bounds = { x: 0, y: 0, width: options.width, height: options.height }
    this.events = new Map(); this.visible = false
    this.webContents = {
      on: (name, fn) => this.events.set('web:' + name, fn), setWindowOpenHandler() {},
      send: (...args) => nativeCalls.push(['send', ...args]), executeJavaScript: async () => {},
    }
    windows.push(this)
  }
  on(name, fn) { this.events.set(name, fn) }
  once(name, fn) { this.on(name, fn) }
  isDestroyed() { return false }
  isVisible() { return this.visible }
  getBounds() { return { ...this.bounds } }
  setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; nativeCalls.push(['position', x, y]) }
  setBounds(b) { this.bounds = { ...b }; nativeCalls.push(['bounds', { ...b }]) }
  setAlwaysOnTop() {} setMenuBarVisibility() {}
  setIgnoreMouseEvents(on, options) { nativeCalls.push(['ignore', on, options]) }
  setFocusable(on) { nativeCalls.push(['focusable', on]) }
  focus() { nativeCalls.push(['focus']) }
  showInactive() { this.visible = true; nativeCalls.push(['showInactive']) }
  hide() { this.visible = false }
  async loadURL(url) { this.url = url; this.events.get('web:did-finish-load')?.(); this.events.get('ready-to-show')?.() }
}
let trayMenu
class FakeTray { setToolTip() {} setContextMenu(menu) { trayMenu = menu } on() {} destroy() {} }
const display = { workArea: a[0], bounds: { ...a[0] }, scaleFactor: 1.5 }
let linked = true
const fakeLink = {
  start: async () => {}, refresh: async () => {}, close() {}, onChange: () => () => {},
  status: () => ({ connected: linked, base: linked ? 'http://127.0.0.1:19387' : null }),
}
const electron = {
  app, BrowserWindow: FakeWindow, Tray: FakeTray, Menu: { buildFromTemplate: (menu) => menu },
  screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display,
    getDisplayNearestPoint: () => display, getCursorScreenPoint: () => cursor, on() {} },
  shell: { openExternal: async () => {} }, ipcMain: { on: (name, fn) => ipc.set(name, fn) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize: () => ({}) }), createEmpty: () => ({}) },
  dialog: { showMessageBox: async () => {}, showErrorBox: (...args) => { throw new Error(args.join(': ')) } },
}
const fakeRequire = (name) => {
  if (name === 'electron') return electron
  if (name === './server.cjs') return { resolveRepoRoot: () => ROOT, startPetServer: async () => ({ petBase: 'http://127.0.0.1:54321', close() {} }) }
  if (name === './dsh-link.cjs') return { createDshLink: () => fakeLink }
  if (name === './window-state.cjs') return require(path.join(SHELL, 'window-state.cjs'))
  return require(name)
}
try {
  vm.runInNewContext(fs.readFileSync(path.join(SHELL, 'main.js'), 'utf8'), {
    require: fakeRequire, __dirname: SHELL, process: { env: { DSH_HOME: home } }, Date: fakeDate,
    console, setTimeout, clearTimeout, setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length }, clearInterval() {},
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  const win = windows[0]
  const sender = { sender: win.webContents }
  const tickPointer = intervals.find((item) => item.ms === 40).fn
  const tickRoam = intervals.find((item) => item.ms === 33).fn
  const mask = { w: 4, h: 4, grid: Array(16).fill(1) }
  mask.grid[0] = 0
  const snapshot = (panels = [], status = 'idle') => ipc.get('pet-input')(sender, { body, mask, panels, status })
  test('one transparent window starts without taking focus', () => {
    assert.equal(windows.length, 1); assert.equal(win.options.focusable, false)
    assert.equal(win.options.transparent, true); assert.equal(win.options.webPreferences.nodeIntegration, false)
    assert(nativeCalls.some((call) => call[0] === 'showInactive'))
    assert.deepEqual([win.bounds.x, win.bounds.y], [100, 150])
  })
  snapshot()
  const p = win.getBounds()
  test('click-through changes only when crossing a model boundary', () => {
    cursor = { x: p.x + body.x + 150, y: p.y + body.y + 150 }
    tickPointer()
    const count = nativeCalls.filter((call) => call[0] === 'ignore').length
    for (let i = 0; i < 20; i++) tickPointer()
    assert.equal(nativeCalls.filter((call) => call[0] === 'ignore').length, count)
    assert.equal(nativeCalls.filter((call) => call[0] === 'ignore').at(-1)[1], false)
    cursor = { x: p.x + 20, y: p.y + 20 }; tickPointer()
    assert.equal(nativeCalls.filter((call) => call[0] === 'ignore').at(-1)[1], true)
  })
  test('foreign IPC sender and transparent background cannot start a drag', () => {
    ipc.get('drag-start')({ sender: {} }, { x: 320, y: 490 })
    ipc.get('drag-start')(sender, { x: 20, y: 20 })
    ipc.get('drag-move')(sender, { dx: 100, dy: 100 })
    assert.deepEqual(win.getBounds(), p)
  })
  test('panels remain clickable but never drag the window', () => {
    snapshot([{ x: 200, y: 380, w: 150, h: 150 }])
    ipc.get('drag-start')(sender, { x: 260, y: 450 })
    ipc.get('drag-end')(sender, { dx: 100, dy: 100 })
    assert.deepEqual(win.getBounds(), p)
    snapshot()
  })
  test('release flushes the latest move and never changes window size', () => {
    ipc.get('drag-start')(sender, { x: 320, y: 490 })
    ipc.get('drag-move')(sender, { dx: 10, dy: 10 })
    ipc.get('drag-end')(sender, { dx: 40, dy: 60 })
    assert.deepEqual(win.getBounds(), { ...p, x: p.x + 40, y: p.y + 60 })
  })
  test('click with no movement leaves the window in place', () => {
    const before = win.getBounds()
    ipc.get('drag-start')(sender, { x: 320, y: 490 })
    ipc.get('drag-end')(sender, { dx: 0, dy: 0 })
    assert.deepEqual(win.getBounds(), before)
  })
  test('focus is enabled for an input field and disabled on blur', () => {
    ipc.get('pet-focus')(sender, true)
    assert(nativeCalls.some((call) => call[0] === 'focus'))
    win.events.get('blur')()
    assert.deepEqual(nativeCalls.filter((call) => call[0] === 'focusable').at(-1), ['focusable', false])
  })
  test('idle roaming moves, and work/panels/hidden state stop movement', () => {
    cursor = { x: 0, y: 0 }; tickPointer()
    now += 40000; snapshot(); tickRoam()
    const before = win.getBounds()
    now += 1000; snapshot(); tickRoam()
    assert.notDeepEqual(win.getBounds(), before)
    snapshot([], 'thinking'); const working = win.getBounds(); now += 1000; tickRoam()
    assert.deepEqual(win.getBounds(), working)
    snapshot([{ x: 10, y: 10, w: 100, h: 100 }]); now += 30000; tickRoam()
    assert.deepEqual(win.getBounds(), working)
    win.hide(); now += 30000; snapshot(); tickRoam(); assert.deepEqual(win.getBounds(), working)
  })
  test('tray exposes persistent roaming and one show/hide control', () => {
    assert.equal(trayMenu.filter((item) => /自主漫游/.test(item.label)).length, 1)
    const item = trayMenu.find((item) => /自主漫游/.test(item.label))
    item.click({ checked: false })
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'))).roaming, false)
  })
  test('ownership preserves unrelated DSH config and is released on exit', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'dsh-live2d-pet.json')))
    assert.match(cfg.desktopEndpoint, /^http:\/\/127\.0\.0\.1:54321\/dsh-pet\/owner\//)
    assert.equal(cfg.lookAtCursor, false)
    events.get('before-quit')()
    const released = JSON.parse(fs.readFileSync(path.join(home, 'dsh-live2d-pet.json')))
    assert.equal(released.desktopEndpoint, undefined); assert.equal(released.height, 180)
  })
  test('generated files exactly match their versioned source templates', () => {
    for (const name of ['main', 'preload']) {
      const source = fs.readFileSync(path.join(ROOT, 'tools', 'shell-gen', 'templates', name + '.cjs'), 'utf8')
      const generated = fs.readFileSync(path.join(SHELL, name + '.js'), 'utf8')
      assert.equal(generated.slice(generated.indexOf('\n') + 1), source)
    }
  })
  console.log('结果：pass ' + pass + ' / fail 0')
} finally {
  // temp is created by this test and has no user data.
  fs.rmSync(temp, { recursive: true, force: true })
}
