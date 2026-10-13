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
test('slow one-pixel and fractional drags retain movement in both directions', () => {
  for (const direction of [-1, 1]) {
    const drag = beginDrag({ x: 500, y: 300, width: 420, height: 600 })
    let result
    for (let i = 1; i <= 30; i++) result = advanceDrag(drag, direction * i / 3, direction * i / 3, body, a)
    assert.equal(result.x, 500 + direction * 10)
    assert.equal(result.y, 300 + direction * 10)
  }
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
      focus: () => nativeCalls.push(['webFocus']),
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
  focus() { this.focused = true; nativeCalls.push(['focus']) }
  isFocused() { return !!this.focused }
  showInactive() { this.visible = true; nativeCalls.push(['showInactive']) }
  hide() { this.visible = false }
  async loadURL(url) { this.url = url; this.events.get('web:did-finish-load')?.(); this.events.get('ready-to-show')?.() }
}
let trayMenu
let trayClick
class FakeTray { setToolTip() {} setContextMenu(menu) { trayMenu = menu } on(name, fn) { if (name === 'click') trayClick = fn } destroy() {} }
const display = { workArea: a[0], bounds: { ...a[0] }, scaleFactor: 1.5 }
let linked = true
const fakeLink = {
  start: async () => {}, refresh: async () => {}, close() {}, onChange: () => () => {},
  status: () => ({ connected: linked, base: linked ? 'http://127.0.0.1:19387' : null }),
}
let serverOptions
const electron = {
  app, BrowserWindow: FakeWindow, Tray: FakeTray, Menu: { buildFromTemplate: (menu) => menu },
  screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display,
    getDisplayNearestPoint: () => display, getCursorScreenPoint: () => cursor, on() {} },
  shell: { openExternal: async () => {} }, ipcMain: { on: (name, fn) => ipc.set(name, fn), handle: (name, fn) => ipc.set('handle:' + name, fn) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize: () => ({}) }), createEmpty: () => ({}) },
  dialog: { showMessageBox: async () => {}, showErrorBox: (...args) => { throw new Error(args.join(': ')) } },
}
const fakeRequire = (name) => {
  if (name === 'electron') return electron
  if (name === './server.cjs') return { resolveRepoRoot: () => ROOT, startPetServer: async (options) => {
    serverOptions = options
    return { petBase: 'http://127.0.0.1:54321', close() {} }
  } }
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
  test('input diagnostics report current native geometry and reject foreign senders', () => {
    const diagnostics = ipc.get('handle:pet-diagnostics')
    assert.equal(diagnostics({ sender: {} }), null)
    const state = diagnostics(sender)
    assert.deepEqual({ ...state.body }, body)
    assert.equal(state.mask.solid, 15)
    assert.equal(state.rendererReady, true)
    assert.equal(state.drag, false)
    ipc.get('pet-trace')(sender, { type: 'pointerdown', x: 320, y: 490 })
    assert.match(fs.readFileSync(path.join(userData, 'boot.log'), 'utf8'), /input pointerdown local=320,490 hit=model/)
  })
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
  test('delayed forwarded hover cannot override the current OS cursor hit', () => {
    cursor = { x: win.bounds.x + 320, y: win.bounds.y + 490 }
    tickPointer()
    ipc.get('pet-hover')(sender, { x: 10, y: 10 })
    assert.equal(nativeCalls.filter((call) => call[0] === 'ignore').at(-1)[1], false)
    cursor = { x: win.bounds.x + 10, y: win.bounds.y + 10 }
    ipc.get('pet-hover')(sender, { x: 320, y: 490 })
    assert.equal(nativeCalls.filter((call) => call[0] === 'ignore').at(-1)[1], true)
  })
  test('animated model hitbox can change without moving the saved layout anchor', () => {
    const before = win.getBounds()
    const model = { ...body, x: body.x - 10, w: body.w + 20, y: body.y + 30, h: body.h - 30 }
    ipc.get('pet-input')(sender, { body, model, mask, panels: [], status: 'idle' })
    assert.deepEqual(win.getBounds(), before)
    cursor = { x: before.x + body.x - 5, y: before.y + body.y + 100 }; tickPointer()
    assert.equal(nativeCalls.filter((call) => call[0] === 'ignore').at(-1)[1], false, 'expanded visible animation must receive input')
    snapshot()
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
  test('focus is enabled for an input field and released when the page says so', () => {
    ipc.get('pet-focus')(sender, true)
    assert(nativeCalls.some((call) => call[0] === 'focus'), '输入框获得焦点时要真的 win.focus()')
    assert.deepEqual(nativeCalls.filter((call) => call[0] === 'focusable').at(-1), ['focusable', true], '输入框激活时窗口必须 focusable（Windows 上非 focusable 收不到键盘）')
    // ⚠️ 回归守门员：**窗口 blur 绝不能把 focusable 关掉**。
    // 真机事故（2026-10-13）"对话框输入不了、时好时坏"就是这个竞态：
    //   窗口一失焦 → focusable=false → 键盘没了；而输入框从未失去 DOM 焦点，
    //   页面的 focusin 不会再触发 → 没人把它设回 true → 输入框变砖。
    const before = nativeCalls.filter((call) => call[0] === 'focusable').length
    win.events.get('blur')()
    assert.equal(nativeCalls.filter((call) => call[0] === 'focusable').length, before,
      '窗口 blur 不许动 focusable（否则输入框会永久收不到键盘）')
    // 释放由页面决定（focusout → pet-focus false）
    ipc.get('pet-focus')(sender, false)
    assert.deepEqual(nativeCalls.filter((call) => call[0] === 'focusable').at(-1), ['focusable', false], '页面说不用输入时才交还焦点')
  })
  test('pass-through is never enabled while geometry is stale', () => {
    // 页面停止上报几何（DSH 接管后 pet.js 会 app.stop()）时，hitKind 一律返回 'none'。
    // 若此时还允许穿透，WS_EX_TRANSPARENT 会盖住整个窗口 → 她身上也点不到，
    // 拖动与按钮全废，而且日志里看不出来。真机事故（2026-10-13）就是这条。
    cursor = { x: 320, y: 500 }
    now += 5000            // 让几何过期（geometryUntil = 上报时间 + 1500）
    tickPointer()
    const lastIgnore = nativeCalls.filter((call) => call[0] === 'ignore').at(-1)
    // 注意：比字段而不是比对象 —— deepStrictEqual 会连原型一起比，壳传来的 options
    // 不是这个 realm 的字面量对象，值一样也会判不等（踩过一次）。
    assert(lastIgnore, '至少发生了一次穿透状态更新')
    assert.equal(lastIgnore[1], false, '几何过期时必须保持可交互（宁可挡鼠标也不能让她失联）')
    assert.equal(lastIgnore[2] && lastIgnore[2].forward, true, '穿透时必须带 forward')
  })
  test('repeated input focus reports do not reconfigure the window or refocus it', () => {
    ipc.get('pet-focus')(sender, { on: true })
    const setters = nativeCalls.filter((call) => call[0] === 'focusable').length
    const activations = nativeCalls.filter((call) => call[0] === 'focus').length
    for (let i = 0; i < 100; i++) ipc.get('pet-focus')(sender, { on: true })
    assert.equal(nativeCalls.filter((call) => call[0] === 'focusable').length, setters)
    assert.equal(nativeCalls.filter((call) => call[0] === 'focus').length, activations)
    win.focused = false; win.events.get('blur')()
    ipc.get('pet-focus')(sender, { on: true })
    assert.equal(win.isFocused(), false, 'background focus notifications must not steal foreground')
    ipc.get('pet-focus')(sender, { on: true, activate: true })
    assert.equal(win.isFocused(), true, 'clicking an already-active textarea must regain OS focus')
    ipc.get('pet-focus')(sender, false)
  })
  test('IME composition keeps passthrough and focus stable until composition ends', () => {
    snapshot(); ipc.get('pet-focus')(sender, true)
    ipc.get('pet-composition')(sender, true)
    cursor = { x: 0, y: 0 }
    tickPointer(); ipc.get('pet-hover')(sender, { x: 10, y: 10 })
    ipc.get('pet-focus')(sender, false)
    assert.equal(ipc.get('handle:pet-diagnostics')(sender).focusInput, true)
    assert.equal(nativeCalls.filter((call) => call[0] === 'ignore').at(-1)[1], false)
    ipc.get('pet-composition')(sender, false); ipc.get('pet-focus')(sender, false); tickPointer()
    assert.equal(nativeCalls.filter((call) => call[0] === 'ignore').at(-1)[1], true)
  })
  test('hide/show is idempotent, retains ownership, and recovers input without changing position', () => {
    snapshot(); const before = win.getBounds()
    ipc.get('shell-msg')(sender, 'hidden')
    const messages = nativeCalls.filter((call) => call[0] === 'send' && call[1] === 'pet-visibility').length
    for (let i = 0; i < 100; i++) ipc.get('shell-msg')(sender, 'hidden')
    assert.equal(nativeCalls.filter((call) => call[0] === 'send' && call[1] === 'pet-visibility').length, messages)
    assert.equal(win.isVisible(), true, 'collapse retains a native window for the recovery tab')
    const tab = { x: 230, y: 490, w: 100, h: 32 }
    ipc.get('pet-input')(sender, { collapsed: true, panels: [tab] })
    cursor = { x: before.x + 280, y: before.y + 506 }; tickPointer()
    assert.equal(nativeCalls.filter((call) => call[0] === 'ignore').at(-1)[1], false)
    ipc.get('drag-start')(sender, { x: 280, y: 506 })
    assert.equal(ipc.get('handle:pet-diagnostics')(sender).drag, true)
    ipc.get('drag-end')(sender, { dx: 0, dy: 0 })
    cursor = { x: before.x + 320, y: before.y + 420 }; tickPointer()
    assert.equal(nativeCalls.filter((call) => call[0] === 'ignore').at(-1)[1], true, 'hidden model cannot intercept input')
    now += 10000
    assert.equal(serverOptions.ownerActive(), true, 'intentional hiding must not reactivate the DSH duplicate')
    ipc.get('pet-focus')(sender, { on: true, activate: true })
    assert.equal(ipc.get('handle:pet-diagnostics')(sender).focusInput, false)
    trayClick()
    assert.equal(win.isVisible(), true)
    assert.deepEqual(win.getBounds(), before)
    assert.equal(nativeCalls.filter((call) => call[0] === 'ignore').at(-1)[1], false, 'show must clear cached click-through')
    snapshot(); cursor = { x: before.x + body.x + 150, y: before.y + body.y + 150 }; tickPointer()
    ipc.get('drag-start')(sender, { x: 320, y: 490 })
    assert.equal(ipc.get('handle:pet-diagnostics')(sender).drag, true)
    ipc.get('drag-end')(sender, { dx: 0, dy: 0 })
    const visibleMessages = nativeCalls.filter((call) => call[0] === 'send' && call[1] === 'pet-visibility').length
    for (let i = 0; i < 100; i++) ipc.get('shell-msg')(sender, 'shown')
    assert.equal(nativeCalls.filter((call) => call[0] === 'send' && call[1] === 'pet-visibility').length, visibleMessages)
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
  test('viewport grows and shrinks for model size while preserving its screen anchor', () => {
    trayClick(); snapshot()
    win.setPosition(400, 100)
    const before = win.getBounds()
    const resizedBody = { x: 10, y: 50, w: 600, h: 450 }
    ipc.get('pet-size')(sender, { width: 644, height: 760 })
    assert.equal(win.bounds.width, 644); assert.equal(win.bounds.height, 760)
    ipc.get('pet-input')(sender, { body: resizedBody, mask, panels: [], status: 'idle' })
    assert.equal(win.bounds.x + resizedBody.x, before.x + body.x)
    assert.equal(win.bounds.y + resizedBody.y, before.y + body.y)
    const count = nativeCalls.filter((call) => call[0] === 'bounds').length
    ipc.get('pet-size')(sender, { width: 644, height: 760 })
    ipc.get('pet-size')({ sender: {} }, { width: 800, height: 900 })
    ipc.get('pet-size')(sender, { width: Infinity, height: 900 })
    assert.equal(nativeCalls.filter((call) => call[0] === 'bounds').length, count)
    ipc.get('pet-size')(sender, { width: 200, height: 200 })
    assert.equal(win.bounds.width, 420); assert.equal(win.bounds.height, 600)
    snapshot()
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
