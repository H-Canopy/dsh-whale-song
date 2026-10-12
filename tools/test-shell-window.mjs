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
    // 真 Electron 的 webContents 同时有 on/once；主进程用 once 挂"单位定案"那种一次性诊断。
    // 桩子少了它会让整轮测试在启动阶段就抛 TypeError。
    once(ev, fn) { rec({ t: 'once', ev: ev }); if (typeof fn === 'function') handlers['wc:' + ev] = fn },
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
  // 【结构性修复 · 真机日志证据】**不再**用 setIgnoreMouseEvents 切穿透：
  //   真机日志里 `preload: mousedown` 0 条、`mouseup` 却到了 —— 说明按下被"穿透"吃掉了
  //   （Electron 的 forward:true 只转发移动，不转发按键）；而 ignore 反复翻转会让整个
  //   分层窗口反复重新合成 = 用户看到的"指针一靠近她就闪"。
  //   所以窗口**永远保持可交互**，精确判定交给页面里的 hitTest（掩码）。
  const ig = of('ignoreMouse')
  ok(ig.length === 0, '不调 setIgnoreMouseEvents（切穿透会吃掉按下 + 触发整窗重合成导致闪）', JSON.stringify(ig))
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
  // 【守门员 · 已更新】旧机制（90ms 轮询 + setIgnoreMouseEvents 切换）**必须保持删除**：
  //   真机日志证明它同时造成"按下被穿透吃掉"（只有 mouseup）与"整窗重合成导致闪"。
  ok(!/setInterval\(poll, 90\)/.test(shellSrc) && !/async function poll\(\)/.test(shellSrc),
    '旧的 90ms 命中轮询保持删除（它造成的闪与抓不住已由真机日志证伪）', '')
  ok(!/function setIgnore\(/.test(shellSrc), 'setIgnore 及其调用保持删除', '')
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
  // 【第二轮重写】拖动从「主进程反推」改成「页面给位移的增量法」。
  //   为什么换：真机日志证明反推（位置 = 光标 − 抓手偏移）只有 x 跟得上、y 会冻住
  //   （cur 的 y 从 318 变到 525，而 set 的 y 一直 114）。增量法没有反推这一步。
  //   同时主人明确要求：**只能抓她本体才拖**，抓透明空气不许动窗口。
  const shellSrc = fs.readFileSync(path.join(SHELL, 'main.js'), 'utf8')
  const preloadSrc = fs.readFileSync(path.join(SHELL, 'preload.js'), 'utf8')
  // ① 门禁：只有 hitTest 判成 model（她本体）才进入拖动
  ok(/if \(kind !== 'model'\) return/.test(shellSrc),
    '拖动门禁：只有按在她本体（hitTest=model）才搬窗口', '')
  ok(!/if \(kind === 'panel'\) return/.test(shellSrc),
    '旧的"只挡 panel"判定已删除（那种写法让透明区也能拖）', '')
  // ② 页面给位移，主进程不做反推
  ok(/const c = clampPet\(dragFrom\.cx \+ dx, dragFrom\.cy \+ dy, dragFrom\.w, dragFrom\.h\)/.test(shellSrc),
    '增量法：新位置 = 当前位置 + 页面给的位移，再夹取', '')
  ok(!/dragFrom\.grab/.test(shellSrc) && !/async function grabOffset/.test(shellSrc),
    '抓手偏移（grabOffset / dragFrom.grab）已彻底删除', '')
  ok(!/getCursorScreenPoint\(\)[\s\S]{0,200}dragFrom\.cx/.test(shellSrc),
    '拖动不再读全局光标反推位置（y 冻死的根源）', '')
  ok(/ipcMain\.on\('drag-move'/.test(shellSrc) && /dragMove = \(adx, ady\) => \{/.test(shellSrc),
    '主进程收 drag-move 并把累计位移换算成"还要挪多少"', '')
  ok(/ipcRenderer\.send\('drag-move', \{ dx: dx, dy: dy \}\)/.test(preloadSrc),
    'preload 上报指针位移（相对按下点的累计量）', '')
  ok(/window\.addEventListener\('mousemove', function \(e\) \{[\s\S]{0,400}dshwDown/.test(preloadSrc),
    'preload 只在按下期间上报位移', '')
  // ③ 节拍：多次 mousemove 合并成一个 STEP_MS 周期，别每毫秒 setBounds
  ok(/const STEP_MS = 33/.test(shellSrc), '拖动节拍仍是 33ms（30fps）', '')
  ok(/if \(movePending\) return/.test(shellSrc) && /movePending = true/.test(shellSrc),
    '同一周期的多次 move 被合并（避免每毫秒 setBounds）', '')
  // ④ 老三条教训必须全在
  ok(/win\.setBounds\(\{ x: x2, y: y2, width: dragFrom\.w, height: dragFrom\.h \}\)/.test(shellSrc),
    '拖动写死按下时的宽高（防系统改动累积）', '')
  ok(/size=' \+ gb\.width/.test(shellSrc), '拖动轨迹记录尺寸（便于发现累积）', '')
  ok(/function clampPet\(x, y, w, h\)/.test(shellSrc) && /const minY = wa\.y - \(h - PET_BODY\.offB/.test(shellSrc),
    'clampPet() 按"她本体留在工作区内"夹取', '')
  ok(/const x2 = c\.x - \(c\.x % 2\), y2 = c\.y - \(c\.y % 2\)/.test(shellSrc),
    '拖动位置量化到偶数（实测只有这样窗口尺寸才不涨）', '')
  ok(/位置越界，已纠正/.test(shellSrc), '按下时立刻纠正越界位置（从出屏状态开始拖也能救回）', '')
  ok(/dragFrom\.cx = ex; dragFrom\.cy = ey/.test(shellSrc),
    '纠正后同步拖动基准（否则第一帧会按旧位置算而跳一下）', '')
  ok(/w: win\.getBounds\(\)\.width, h: win\.getBounds\(\)\.height/.test(shellSrc),
    'drag-start 时记下宽高', '')
  // ⑤ 累加不会被夹取"吃掉"：基准点要跟着实际生效位置走
  ok(/const appliedX = x2 - dragFrom\.cx/.test(shellSrc) && /dragFrom\.pendDx -= appliedX/.test(shellSrc),
    '夹取吃掉的位移会从待处理量里扣掉（贴边不积压）', '')
  // ⑥ 【真 bug 守门员】掩码只覆盖画布约 78%×79%，她裙摆/头/脚这些地方会被判成"空气"
  //    → 主人点她身上却拖不动。修法是把测试点朝掩码中心收缩（等价于放大掩码），
  //    单靠"往外试固定半径"实测无效（在她较窄的高度上补不到左侧）。
  ok(/PET_GRAB_ZOOM/.test(shellSrc) && /for\(var step=1;step<=4;step\+\+\)/.test(shellSrc),
    '抓取命中按比例放大（掩码边缘之外也能抓住她，否则点她身上会拖不动）', '')
  ok(!/PET_GRAB_RADIUS/.test(shellSrc),
    '不再用"固定半径往外试"那套（实测补不到她较窄的高度）', '')
  // 命中自检：没有它，下次再出"点她拖不动"只能靠猜
  ok(/命中自检: stage=/.test(shellSrc), '保留命中自检（严格 vs 放大 对比 + 掩码字符图）', '')
  ok(!/dragTimer = setInterval/.test(shellSrc), '不再用 setInterval 驱动拖动', '')
  ok(!/clearInterval\(dragTimer\)/.test(shellSrc) && /clearTimeout\(dragTimer\)/.test(shellSrc),
    'dragTimer 是 setTimeout 句柄，清理用 clearTimeout', '')
  // 【真 bug 守门员 · 已升级】原来的问题是"拖动期间不能切穿透"；现在更彻底：
  // 整个切穿透机制都没了（poll + setIgnore 一起删除），所以只要断言它**不存在**即可 ——
  // 这样"拖动中被切回穿透"这一类 bug 在结构上不可能再发生。
  // 注意只看**代码行**：注释里会提到这些 API 名（说明为什么废弃）。
  {
    const codeOnly = shellSrc.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    ok(!/async function poll\(\)/.test(codeOnly) && !/setIgnoreMouseEvents\s*\(/.test(codeOnly) && !/function setIgnore\(/.test(codeOnly),
      '切穿透机制整体不存在（拖动中不可能再被切回穿透）', '')
  }
}

console.log('\n--- 「收起成小球」已按主人要求整条删除 ---')
{
  // 为什么删：真机两次事故 —— ① 收起来后小球被放到屏幕外（点不到、回不来）；
  // ② 小球后来渲染成一个巨大的深色圆盘且**越变越大**。
  // 它唯一的价值就是"折叠"，而代价是可能永久失联，所以整条线拆掉，不留折叠态。
  const collapsedCode = fs.readFileSync(path.join(SHELL, 'main.js'), 'utf8')
  const preloadCode = fs.readFileSync(path.join(SHELL, 'preload.js'), 'utf8')
  ok(!/ballWin/.test(collapsedCode) && !/createBall/.test(collapsedCode) && !/ballHTML/.test(collapsedCode),
    '小球窗口（第二个 BrowserWindow）已彻底删除', '')
  ok(!/\bcollapsed\b/.test(collapsedCode) && !/收起成小球/.test(collapsedCode),
    '折叠态与它的托盘菜单项已删除（不再有"回不来"的状态）', '')
  ok(!/ballMove|ballDrop/.test(preloadCode), 'preload 里小球用的桥已删除', '')
  // 但"显示她"的能力必须留着（收到 collapse/expand/shown 一律显示）
  ok(/function showPetAlways\(\)/.test(collapsedCode) && /showPetAlways\(\)/.test(collapsedCode),
    '保留 showPetAlways()：任何"显示她"的请求都有出口（折叠删了但显示能力不能丢）', '')
  ok(/case 'collapse'/.test(collapsedCode) && /case 'expand'/.test(collapsedCode),
    '旧的 collapse/expand 协议仍被接受（老前端发过来不会报错）', '')
  const ipc = report.filter((r) => r.t === 'win').length
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
