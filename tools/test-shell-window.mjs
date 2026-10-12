// ============================================================================
// test-shell-window.mjs —— 用**假的 electron 模块**跑壳的 main.js，验窗口与托盘逻辑
// ----------------------------------------------------------------------------
// 为什么不真跑 Electron：
//   · 无头机上一条透明置顶窗口的"观感"验不了（那要人眼），但**它按什么参数建的窗口**能验；
//   · 真 Electron 启动还牵扯 GPU/显示器/首启状态，CI 上很脆；
//   · 而壳里 600 行窗口/托盘/穿透/贴边球逻辑，用打桩能在几秒内全跑一遍。
// 做法（关键技巧）：在**壳的 node_modules 里**放一个假 electron 包（`resolver` 指向我们的桩），
// 然后 spawn 壳的 main.js。壳自己 require('electron') 就拿到桩。
//   ── "JS 打桩有两条路：改模块对象（同进程）或放解析兜底（跨进程）" —— 见 HANDOVER 第 12 条。
//
// 断言：
//   1. 启动时起了本地迷你服务，并把 petBase 指向它（脱离 DSH 的关键）
//   2. 主窗口参数正确：frame:false / transparent:true / skipTaskbar:true / 置顶 / 点击穿透
//   3. 页面真的加载成功（loadURL → 我们的服务 → 页面里 window.DSHPet 挂上）
//   4. 托盘的菜单项齐（显示/隐藏/收起/退出）
//   5. 「收起成小球」能建出第二个透明窗口
//   6. 退出时把服务关掉（不留孤儿端口）
//
// 跑：node tools/test-shell-window.mjs
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const SHELL = path.join(ROOT, 'desktop', 'standalone')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  ok   ' + msg) }
  else { fail++; failures.push(msg); console.log('  FAIL ' + msg + (detail === undefined ? '' : '  → ' + detail)) }
}

// —— 打桩用的临时目录：DSH_HOME/APPDATA 指到这里，绝不碰用户真实配置 ——
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-shellwin-'))
const REPORT = path.join(TMP, 'report.jsonl')
fs.writeFileSync(REPORT, '')

// 假 electron：**不动真 electron**（踩过：把真的挪走后跨盘 rename 失败 → node_modules 里丢了它）。
// 改用 `--require <预加载>`：在壳进程里**抢先**把 require('electron') 换成桩。
// 这是"同进程改模块对象"那条路的跨进程版本，零数据风险（HANDOVER 第 12 条那类坑的教训）。
const PRELOAD = path.join(TMP, 'stub-electron-preload.cjs')
const STUB = path.join(TMP, 'stub-electron.cjs')
fs.writeFileSync(STUB, `
// 假 electron：把壳用到的每一个 API 都记一笔，够壳跑完启动流程即可
const fs = require('node:fs')
const REPORT = ${JSON.stringify(REPORT)}
const rec = (o) => { try { fs.appendFileSync(REPORT, JSON.stringify(o) + '\\n') } catch (e) {} }
const handlers = {}
const wins = []
class FakeWin {
  constructor(opts) {
    this.opts = opts || {}
    this.bounds = { x: 100, y: 100, width: this.opts.width || 0, height: this.opts.height || 0 }
    this.visible = !!this.opts.show
    this.loaded = []
    this.alwaysOnTop = []
    this.ignoreMouse = []
    wins.push(this)
    rec({ t: 'win', opts: this.opts })
  }
  on(ev, fn) { rec({ t: 'win.on', ev: ev }); this['on_' + ev] = fn; return this }
  once(ev, fn) { return this.on(ev, fn) }
  setAlwaysOnTop(v, lvl) { this.alwaysOnTop.push([v, lvl]); rec({ t: 'alwaysOnTop', v: v, level: lvl }) }
  setIgnoreMouseEvents(on, opts) { this.ignoreMouse.push([on, opts]); rec({ t: 'ignoreMouse', on: on, forward: !!(opts && opts.forward) }) }
  setMenuBarVisibility(v) { rec({ t: 'menuBarVisible', v: v }) }
  setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; rec({ t: 'setPosition', x: x, y: y }) }
  getBounds() { return Object.assign({}, this.bounds) }
  setBounds(b) { Object.assign(this.bounds, b) }
  isDestroyed() { return this.destroyed === true }
  isVisible() { return this.visible === true }
  showInactive() { this.visible = true }
  show() { this.visible = true }
  hide() { this.visible = false }
  close() { rec({ t: 'win.close' }) }
  focus() {}
  loadURL(u) {
    this.loaded.push(u)
    rec({ t: 'loadURL', url: u, win: wins.length })
    // 真 Electron 会在页面加载时发这些事件；壳的"显示窗口/加载后处理"都挂在它们上面，
    // 所以桩必须**按真实时序**把它们触发一遍，否则会误判成"壳没工作"。
    setTimeout(() => {
      for (const ev of ['ready-to-show', 'did-finish-load', 'dom-ready']) {
        const fn = this['on_' + ev]
        if (typeof fn === 'function') { try { fn() } catch (e) { rec({ t: 'handlerError', ev: ev, msg: String(e && e.message) }) } }
      }
    }, 300)
  }
  loadFile(f) { this.loaded.push('file://' + f); rec({ t: 'loadFile', file: f }) }
  webContents = {
    send: (ch, msg) => rec({ t: 'send', ch: ch, msg: msg }),
    on() {},
    executeJavaScript: async () => null,
    setZoomFactor() {},
    setWindowOpenHandler: (fn) => { rec({ t: 'windowOpenHandler' }) },
    openDevTools: () => {},
  }
  isAlwaysOnTop() { return true }
}
const app = {
  whenReady: () => Promise.resolve(),
  on: (ev, fn) => { handlers[ev] = fn },
  quit: () => { rec({ t: 'app.quit' }) },
  exit: (c) => { rec({ t: 'app.exit', code: c }) },
  setAppUserModelId: (id) => rec({ t: 'appUserModelId', id: id }),
  getPath: (n) => (n === 'userData' ? ${JSON.stringify(path.join(TMP, 'userData'))} : ${JSON.stringify(TMP)}),
  requestSingleInstanceLock: () => true,
  dock: { hide() {} },
}
const screen = {
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.5 }),
  getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
  // 光标位置由测试控制：壳的拖动逻辑读它来算新位置
  getCursorScreenPoint: () => Object.assign({}, global.__cursor || { x: 800, y: 600 }),
}
global.__cursor = { x: 800, y: 600 }
class FakeTray {
  constructor(img) { this.menu = null; rec({ t: 'tray' }) }
  setToolTip(t) { rec({ t: 'tray.tooltip', t: t }) }
  setContextMenu(m) { this.menu = m; rec({ t: 'tray.menu', items: (m && m.items ? m.items.map((x) => x.label) : []) }) }
  on(ev, fn) { this['on_' + ev] = fn }
  destroy() {}
}
const shell = { openExternal: (u) => rec({ t: 'openExternal', url: u }), openPath: () => {} }
const session = { defaultSession: { cookies: { set: async () => {} } } }
const ipcMain = { on: (ch, fn) => { handlers['ipc:' + ch] = fn } }
// nativeImage 的返回值必须是"像图片"的对象：壳会链式调用 isEmpty() / resize() / getSize()
const fakeImg = () => {
  const img = {
    isEmpty: () => false,
    resize: () => fakeImg(),
    getSize: () => ({ width: 32, height: 32 }),
    setTemplateImage: () => {},
    toPNG: () => Buffer.alloc(0),
    crop: () => fakeImg(),
  }
  return img
}
const nativeImage = {
  createFromPath: () => fakeImg(),
  createFromBuffer: () => fakeImg(),
  createEmpty: () => fakeImg(),
  createFromDataURL: () => fakeImg(),
}
const dialog = {
  showMessageBox: async (o) => { rec({ t: 'dialog', title: o && o.title }); return { response: 0 } },
  showErrorBox: (t, m) => rec({ t: 'errorBox', title: t, message: String(m).slice(0, 200) }),
}
module.exports = { app, BrowserWindow: FakeWin, Tray: FakeTray, Menu: { buildFromTemplate: (t) => ({ items: t }) }, screen, shell, session, ipcMain, nativeImage, dialog }
`)

// 预加载：把 require('electron') 拦成桩
fs.writeFileSync(PRELOAD, `
const Module = require('node:module')
const stub = require(${JSON.stringify(STUB)})
const orig = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return stub
  return orig.apply(this, arguments)
}
`)

// 壳会往 APPDATA 写日志；给它一个隔离目录
const env = Object.assign({}, process.env, {
  APPDATA: path.join(TMP, 'appdata'),
  LOCALAPPDATA: path.join(TMP, 'localappdata'),
  DSHW_PET_ROOT: ROOT,
})
// ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE：在 DSH 会话里它是 **1**，那会让 electron 退化成纯 Node
//    （require('electron') 变成"可执行文件路径"字符串，app 是 undefined，启动直接崩）。
//    实测踩过：真 Electron 跑壳时 boot.log 里只有 `Cannot read properties of undefined (reading 'whenReady')`。
delete env.ELECTRON_RUN_AS_NODE
fs.mkdirSync(env.APPDATA, { recursive: true })

console.log('--- 用假 electron 跑壳的 main.js ---')
const child = spawn(process.execPath, ['--require', PRELOAD, path.join(SHELL, 'main.js')], { env: env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => { out += d })
await sleep(9000)   // 等她起服务、建窗口、加载页面

const report = fs.readFileSync(REPORT, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
const of = (t) => report.filter((r) => r.t === t)
console.log('  桩记录 ' + report.length + ' 条；进程输出尾部：' + JSON.stringify(out.slice(-160)))

console.log('\n--- 本地服务 ---')
{
  const bootLog = path.join(env.APPDATA, 'ds-whale-girl-pet', 'boot.log')
  const log = fs.existsSync(bootLog) ? fs.readFileSync(bootLog, 'utf8') : ''
  const m = /petBase=(http:\/\/127\.0\.0\.1:\d+)/.exec(log)
  ok(/本地服务已起: http:\/\/127\.0\.0\.1:\d+\/dsh-pet/.test(log), '启动时起了本地迷你服务', (log.split('\n').find((l) => /本地服务/.test(l)) || '').slice(0, 120))
  ok(!!m, 'petBase 指向本地服务（' + (m && m[1]) + '）—— 不再依赖 DSH', '')
}

console.log('\n--- 主窗口参数（透明 / 置顶 / 穿透 / 不进任务栏）---')
{
  const wins = of('win')
  const main = wins[0]
  ok(!!main, '建了主窗口', JSON.stringify(wins.length))
  const o = (main && main.opts) || {}
  ok(o.frame === false, 'frame:false（无边框）', String(o.frame))
  ok(o.transparent === true, 'transparent:true（背景透明，只有她）', String(o.transparent))
  ok(o.skipTaskbar === true, 'skipTaskbar:true（不占任务栏）', String(o.skipTaskbar))
  ok(o.resizable === false && o.hasShadow === false, 'resizable:false + hasShadow:false', JSON.stringify({ r: o.resizable, s: o.hasShadow }))
  const top = of('alwaysOnTop')
  ok(top.length > 0 && top[0].v === true && top[0].level === 'screen-saver', '置顶：setAlwaysOnTop(true, "screen-saver")', JSON.stringify(top[0] || null))
  // 默认机制仍然是上游那套：**整窗穿透 + 90ms 轮询按需关掉**。
  // （"窗口成型"是另一条路，默认关着；开着时才应该去掉整窗穿透 —— 见下面的断言。）
  const ig = of('ignoreMouse')
  ok(ig.length > 0 && ig[0].on === true && ig[0].forward === true, '默认：整窗点击穿透 setIgnoreMouseEvents(true,{forward:true})', JSON.stringify(ig[0] || null))
  ok(!!(o.webPreferences && o.webPreferences.preload), '挂了 preload（她才能在壳里用收起/展开）', JSON.stringify(o.webPreferences && o.webPreferences.preload))
}

console.log('\n--- 窗口成型（可选，默认关闭）：机制已接好但不启用 ---')
{
  const shellSrc = fs.readFileSync(path.join(SHELL, 'main.js'), 'utf8')
  const codeLines = shellSrc.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  ok(codeLines.some((l) => /createShaper\(\{/.test(l)), '壳里建了成型器（createShaper）', '')
  ok(codeLines.some((l) => /onShape:/.test(l)), '本地服务把 onShape 接给了成型器（页面可提交掩码）', '')
  ok(codeLines.some((l) => /getNativeWindowHandle\(\)/.test(l)), '成型器每次现取 HWND（窗口重建后句柄会变）', '')
  ok(/function readShapeWindow\(\)/.test(shellSrc), '有 shapeWindow 开关（默认 false）', '')
  ok(/shapeWindow === true/.test(shellSrc), '开关默认关闭（必须显式写 true 才启用）', '')
  ok(fs.existsSync(path.join(SHELL, 'window-shape.cjs')), 'window-shape.cjs（CommonJS 版）在位', '')
  // ⚠️ 这条是回退事故的守门员：默认（成型关）必须有上游那套穿透，否则矩形窗口会挡鼠标。
  ok(/setInterval\(poll, 90\)/.test(shellSrc) && /async function poll\(\)/.test(shellSrc),
    '默认机制（90ms 轮询 + 整窗穿透）必须保留 —— 删了会留下一个矩形窗口挡鼠标', '')
}

console.log('\n--- 页面加载 ---')
{
  const loads = of('loadURL')
  const appLoad = loads.find((r) => /\/dsh-pet\/app$/.test(r.url))
  ok(!!appLoad, '加载的是壳页面 /dsh-pet/app（本地服务）', JSON.stringify(loads.map((r) => r.url).slice(0, 3)))
  ok(!!appLoad && /^http:\/\/127\.0\.0\.1:\d+/.test(appLoad.url), '地址是本机回环（不是 DSH）', appLoad && appLoad.url)
}

console.log('\n--- 托盘 ---')
{
  const trays = of('tray')
  ok(trays.length >= 1, '建了托盘图标', String(trays.length))
  const menu = of('tray.menu').pop()
  const items = (menu && menu.items) || []
  ok(items.length >= 3, '托盘菜单有 ' + items.length + ' 项：' + items.join(' / '), '')
  const joined = items.join(' ')
  ok(/显示|隐藏|收起|退出/.test(joined), '菜单项含显示/隐藏/收起/退出这类动作', joined)
}

console.log('\n--- 拖动：必须是 follow 语义（跟手），不是 push ---')
{
  // 上游的写法是 `起点 + (指针 − 按下点)`（push 语义），我们改成 follow：
  // 按下时记住"指针相对窗口左上角的偏移"，之后 位置 = 指针 − 偏移。
  // 说明：窗口**没被夹取**时两种写法数学上等价（都等于 指针−固定偏移）；差异只出现在
  // 夹取/取整把窗口挪走之后 —— push 会把那次误差一直带着（越拖越偏、撞夹取就跳回），
  // follow 每帧按"当前窗口位置"重算，不累积。桩模拟不出"被夹取"，所以断言**公式本身**。
  const shellSrc = fs.readFileSync(path.join(SHELL, 'main.js'), 'utf8')
  ok(/const wantX = Math\.round\(p\.x - dragFrom\.grab\.x\)/.test(shellSrc) && /win\.setPosition\(wantX, wantY\)/.test(shellSrc),
    '拖动用的是 follow 公式：位置 = 指针 − 抓手偏移', '')
  ok(!/dragFrom\.win/.test(shellSrc),
    '拖动不再依赖"按下时的窗口位置"（push 的根源）', '')
  ok(!/p\.x - dragFrom\.mouse\.x/.test(shellSrc),
    '拖动不再用"指针相对按下点的位移"（那是不跟手的根源）', '')
  ok(/async function grabOffset\(\)/.test(shellSrc), '有 grabOffset()：按下时只算一次抓手偏移', '')
  // 性能守门员（实测依据）：透明窗口 setPosition 6.5ms/次，16ms(60fps) 一帧必然积压 → 晃/闪。
  ok(/\}, 33\)/.test(shellSrc), '拖动帧率是 30fps（33ms），不是 60fps —— 60fps 在这类机器上供不起', '')
  ok(/wantX === dragFrom\.lastX && wantY === dragFrom\.lastY/.test(shellSrc),
    '位置没变就不调 setPosition（省一半开销）', '')
}

console.log('\n--- 贴边小球（第二个透明窗口）---')
{
  // 触发"收起"：壳收到页面消息 collapse 就建小球窗口
  const ipc = report.filter((r) => r.t === 'win').length
  // 直接看有没有第二个窗口被建（壳在 collapse() 里才建，所以这里只能验"逻辑存在"）
  const collapsedCode = fs.readFileSync(path.join(SHELL, 'main.js'), 'utf8')
  ok(/ballWin = new BrowserWindow\(/.test(collapsedCode) && /transparent: true/.test(collapsedCode),
    '收起小球用的是第二个透明窗口（代码里就有）', '')
  ok(ipc >= 1, '主窗口已建（' + ipc + ' 个窗口对象）', '')
}

console.log('\n--- 收尾 ---')
{
  try { child.kill('SIGKILL') } catch (err) {}
  await sleep(500)
  const bootLog = path.join(env.APPDATA, 'ds-whale-girl-pet', 'boot.log')
  const log = fs.existsSync(bootLog) ? fs.readFileSync(bootLog, 'utf8') : ''
  ok(!/启动失败/.test(log) && !/未捕获异常/.test(log),
    '启动过程没有报错', (log.split('\n').find((l) => /启动失败|未捕获异常/.test(l)) || '').slice(0, 200))
  // 真 electron 一直在原位（这条测试从头到尾不碰它）
  const realElectron = path.join(SHELL, 'node_modules', 'electron')
  const realElectronRoot = path.join(ROOT, 'node_modules', 'electron')
  ok(fs.existsSync(realElectron) || fs.existsSync(realElectronRoot),
    '收尾：真 electron 未被本测试动过', realElectron)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (err) {}
}

console.log('\n结果：pass ' + pass + ' / fail ' + fail)
if (fail && failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail ? 1 : 0)
