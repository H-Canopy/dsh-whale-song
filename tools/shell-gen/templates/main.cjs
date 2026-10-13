'use strict'
// Source template. Generated into desktop/standalone/main.js by make-standalone-shell.mjs.
const { app, BrowserWindow, Tray, Menu, screen, shell, ipcMain, nativeImage, dialog, powerMonitor } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { startPetServer, resolveRepoRoot } = require('./server.cjs')
const { createDshLink } = require('./dsh-link.cjs')
const { DEFAULT_BODY, clampWindow, beginDrag, advanceDrag, savedPosition, restorePosition } = require('./window-state.cjs')

app.setName('DS-WhaleSong-Pet')
app.setAppUserModelId('com.hcanopy.dsh.whalesongpet')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'dsh-live2d-pet.json')
const OWNER_PATH = '/dsh-pet/owner/' + crypto.randomUUID()
const WIN_W = 420
const WIN_H = 600
let win = null
let tray = null
let server = null
let link = null
let body = { ...DEFAULT_BODY }
let geometry = null
let drag = null
let pendingMove = null
let moveTimer = null
let lastIgnore = null
let focusInput = false
let composing = false
let petHidden = false
let rendererReady = false
let lowPower = false
let roam = null
let nextRoamAt = Date.now() + 25000
let pointer = null
let geometryUntil = 0
let suspended = false
let rendererLoaded = false
let rendererAnnounced = false
let recovery = null
let recoverySequence = 0
let recoveryReloaded = false
let lastFrameAt = 0
let frameObserved = false
// 上一次上报的面板集合指纹：只在**变化时**打一行日志（见 inputSnapshot）。
let lastPanelKey = null
let shuttingDown = false
let ownerEndpoint = ''
let priorOwnerEndpoint
let cachedSettings = null
const timers = []
const readJSON = (file, fallback = {}) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback }
}
const writeJSON = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(file + '.tmp', file)
}
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const settings = () => {
  if (!cachedSettings) {
    const value = readJSON(settingsFile())
    cachedSettings = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }
  return cachedSettings
}
function updateSettings(patch) { cachedSettings = { ...settings(), ...patch }; writeJSON(settingsFile(), cachedSettings) }
const areas = () => screen.getAllDisplays().map((d) => d.workArea)
const validWin = () => win && !win.isDestroyed()
// Keep the toolbar below the model inside the monitor work area too.
const movementBody = () => ({ ...body, h: body.h + 48 })
function bootLog(message) {
  try {
    const file = path.join(app.getPath('userData'), 'boot.log')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, new Date().toISOString() + ' ' + message + '\n', 'utf8')
  } catch {}
}
function claimOwner() {
  const config = readJSON(CONFIG_FILE)
  priorOwnerEndpoint = config.desktopEndpoint
  ownerEndpoint = server.petBase + OWNER_PATH
  writeJSON(CONFIG_FILE, { ...config, desktopEndpoint: ownerEndpoint })
}
function releaseOwner() {
  const config = readJSON(CONFIG_FILE)
  if (config.desktopEndpoint !== ownerEndpoint) return
  // A previous crashed shell's endpoint is intentionally not restored.
  delete config.desktopEndpoint
  if (priorOwnerEndpoint && priorOwnerEndpoint !== ownerEndpoint && !/\/dsh-pet\/owner\//.test(priorOwnerEndpoint)) {
    config.desktopEndpoint = priorOwnerEndpoint
  }
  writeJSON(CONFIG_FILE, config)
}
function savePos() {
  if (!validWin()) return
  try { writeJSON(path.join(app.getPath('userData'), 'pos.json'), savedPosition(win.getBounds(), body, areas())) } catch (err) { bootLog('position save: ' + err.message) }
}
/**
 * 切换整窗穿透。
 *
 * `why` 是**判定依据**，会一起写进日志 —— 这是被真机事故逼出来的：
 * 2026-10-13 两次"她点不到"，日志里**只有 ON/OFF、没有为什么**，
 * 于是分不清是「命中算错（她身上被判成空气）」还是「鼠标压根没到她身上」，
 * 只能靠猜，白绕两轮。现在切换时把「光标在她窗口内的坐标 + 命中类型 +
 * 几何是否新鲜」一并记下，一眼就能定性。
 */
function setIgnoreMouse(ignore, why) {
  if (!validWin() || lastIgnore === ignore || ((drag || (composing && focusInput)) && ignore)) return
  bootLog('passthrough ' + (ignore ? 'ON (click-through)' : 'OFF (interactive)')
    + (why ? '  [' + why + ']' : ''))
  win.setIgnoreMouseEvents(ignore, { forward: true })
  lastIgnore = ignore
}
// Missing/expired geometry cannot justify making the entire visible character unclickable.
function geometryFresh() { return !!geometry && Date.now() < geometryUntil }
/**
 * 命中容差（CSS 像素）：可见像素周围多少距离内也算"在她身上"。
 *
 * 为什么是 14 而不是更小（原来 5）：真机实测（2026-10-13）把她的可点区域映射出来，
 * 发现**只有约 240×160 CSS 且中间有洞** —— 她自己、本子、笔之间的缝隙全被判成空气，
 * 鼠标落在缝隙里就穿透，表现就是"点不了、也拖不动"，而用户看着觉得"明明在她身上"。
 * 容差太小的副作用（误判远处空气）远小于"抓不住她"。
 *
 * 注意：这个值**只扩张掩码的命中范围**，不会动窗口/渲染；
 * 而且要配合 `inside(model)` 那道外框检查，所以不会延伸到整个窗口。
 */
const HIT_TOLERANCE_CSS = 14
/**
 * 迟滞宽度（CSS 像素）：状态确定后，边界要再"多让开"这么多才允许翻转。
 *
 * 为什么必须要它 —— 真机实测（2026-10-13）拿到铁证：
 *   掩码每 MASK_REFRESH_MS=1200ms 重采一次，而**校验和每次都不一样**：
 *     mask 128x111 sum=5905586 → 5903204 → 5906530 → 5807933 → …
 *   因为她一直在呼吸/眨眼/物理摆动，剪影的**边缘像素**在"她/空气"之间来回翻。
 *   于是**同一个光标坐标、同一个 fresh=true**，判定却在 hit=model / hit=none 之间翻：
 *     passthrough ON  [cursor=236,392 hit=none  fresh=true]
 *     passthrough OFF [cursor=236,392 hit=model fresh=true]
 *   后果：鼠标停在她轮廓附近时，按下那一刻可能正好是空气 ⇒ 穿透 ⇒
 *   **点不到、也拖不动**。用户报的"刚刚还是好的，又不行了"就是这个。
 *
 * 迟滞怎么解决：**已经在交互态时，必须离开她更远才恢复穿透**。
 * 这样边缘像素翻几次都不会改变窗口状态 —— 状态只在真正越过边界时才翻。
 * 代价：一旦抓住她，要离她大约 (HIT_TOLERANCE_CSS + 这个值) 才放手，体感上更"抓得住"。
 */
const HIT_HYSTERESIS_CSS = 6
function hitKind(x, y) {
  if (!geometry) return 'none'
  const inside = (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
  if (geometry.panels.some(inside)) return 'panel'
  if (petHidden) return 'none'
  const m = geometry.mask
  const model = geometry.model || body
  if (!inside(model)) return 'none'
  if (!m) return 'model'
  const gx = Math.floor((x - model.x) * m.w / model.w)
  const gy = Math.floor((y - model.y) * m.h / model.h)
  // 掩码格子 → CSS 像素的换算：把容差从 CSS 换回格子数
  const rx = Math.max(1, Math.ceil(HIT_TOLERANCE_CSS * m.w / model.w))
  const ry = Math.max(1, Math.ceil(HIT_TOLERANCE_CSS * m.h / model.h))
  for (let yy = Math.max(0, gy - ry); yy <= Math.min(m.h - 1, gy + ry); yy++) {
    for (let xx = Math.max(0, gx - rx); xx <= Math.min(m.w - 1, gx + rx); xx++) {
      if (m.grid[yy * m.w + xx]) return 'model'
    }
  }
  return 'none'
}
/** 迟滞版命中判定：只在"穿透态"时用更紧的容差，在"交互态"时用更松的容差。 */
function hitKindSticky(x, y, keepInteractive) {
  const kind = hitKind(x, y)
  if (kind !== 'none' || !keepInteractive || !geometry || petHidden) return kind
  const m = geometry.mask
  const model = geometry.model || body
  if (!m) return kind
  const pad = HIT_TOLERANCE_CSS + HIT_HYSTERESIS_CSS
  const gx = Math.floor((x - model.x) * m.w / model.w)
  const gy = Math.floor((y - model.y) * m.h / model.h)
  const rx = Math.max(1, Math.ceil(pad * m.w / model.w))
  const ry = Math.max(1, Math.ceil(pad * m.h / model.h))
  for (let yy = Math.max(0, gy - ry); yy <= Math.min(m.h - 1, gy + ry); yy++) {
    for (let xx = Math.max(0, gx - rx); xx <= Math.min(m.w - 1, gx + rx); xx++) {
      if (m.grid[yy * m.w + xx]) return 'model'
    }
  }
  return 'none'
}
function cancelRoam(delay = 20000) { roam = null; nextRoamAt = Date.now() + delay }
function inputSnapshot(snapshot) {
  if (suspended || !snapshot || (recovery && snapshot.recoveryId !== recovery.id)) return
  const frameFresh = !Number.isFinite(snapshot.renderAge) || snapshot.renderAge < 3000
  if (Number.isFinite(snapshot.renderAge)) { frameObserved = true; lastFrameAt = Date.now() - Math.max(0, snapshot.renderAge) }
  // Hidden CSS transforms are not a new model anchor. Resume with a fresh snapshot on show.
  if (petHidden) {
    // Collapsing leaves a visible recovery tab; retain the model's saved anchor.
    if (!snapshot || snapshot.collapsed !== true || !Array.isArray(snapshot.panels)) return
    const panels = snapshot.panels.filter((r) => r && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r[k]))
      && r.w > 0 && r.h > 0 && r.w < 500 && r.h < 500).slice(0, 1)
    geometry = { panels, mask: null, status: 'idle', roamBlocked: true }
    geometryUntil = Date.now() + 1500
    if (frameFresh) completeRecovery()
    return
  }
  if (!snapshot || !snapshot.body || !Array.isArray(snapshot.panels)) return
  const rect = (r) => r && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(r[key])) && r.w > 0 && r.h > 0 && r.w < 2000 && r.h < 2000
  if (!rect(snapshot.body)) return
  const newBody = snapshot.body
  const first = !geometry
  const changed = first || Math.abs(body.x - newBody.x) > 2 || Math.abs(body.y - newBody.y) > 2
    || Math.abs(body.w - newBody.w) > 2 || Math.abs(body.h - newBody.h) > 2
  body = newBody
  const m = snapshot.mask
  const mask = m && Number.isInteger(m.w) && Number.isInteger(m.h) && m.w > 0 && m.h > 0 && m.w * m.h <= 65536
    && Array.isArray(m.grid) && m.grid.length === m.w * m.h ? m : geometry && geometry.mask
  // 掩码一到就记一行：尺寸 + 校验和 + 版本号。
  // 为什么要记校验和：真机上出现"同一光标坐标、同一 fresh=true，却在 hit=model / hit=none
  // 之间来回翻"。有了这三项就能一眼分清是「掩码内容在变」还是「掩码没变、是别的在抖」。
  // 只在新掩码到达时打（页面每次重采才发一次，周期 1200ms），所以不会刷屏。
  if (m && mask === m) {
    let sum = 0
    for (let i = 0; i < m.grid.length; i += 7) sum = (sum + m.grid[i] * (i + 1)) % 1000000007
    bootLog('mask ' + m.w + 'x' + m.h + ' sum=' + sum + ' at=' + (snapshot.maskAt === undefined ? 'undef' : snapshot.maskAt))
  }
  const panels = snapshot.panels.filter(rect).slice(0, 32)
  // 面板集合**变化时**才记一行（低频）。
  // 为什么需要：真机上出现过"点在看着空白的左上角，却被判成 hit=panel"，
  // 而面板在 hitKind 里**优先于她本体** —— 若那些矩形是幽灵（不可见却仍上报），
  // 就会**吃掉本该给她的点击**，表现就是"点不了"。有这行就能直接对账，
  // 不用再靠坐标反推"那片到底是什么"。
  const panelKey = panels.map((r) => Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.w) + 'x' + Math.round(r.h)).join(' | ')
  if (panelKey !== lastPanelKey) {
    lastPanelKey = panelKey
    bootLog('panels ' + panels.length + (panels.length ? '  [' + panelKey + ']' : '  (none)'))
  }
  geometry = { panels, mask, maskAt: mask ? (snapshot.maskAt || 0) : (geometry ? geometry.maskAt : 0),
    model: rect(snapshot.model) ? snapshot.model : newBody, status: String(snapshot.status || 'idle'),
    roamBlocked: typeof snapshot.roamBlocked === 'boolean' ? snapshot.roamBlocked : snapshot.panels.length > 0 }
  if (typeof snapshot.lowPower === 'boolean') lowPower = snapshot.lowPower
  rendererReady = frameFresh
  geometryUntil = Date.now() + 1500
  if (changed && !drag && validWin()) {
    const current = win.getBounds()
    const p = first ? restorePosition(readJSON(path.join(app.getPath('userData'), 'pos.json'), null), movementBody(), areas(), current)
      : clampWindow(current, movementBody(), areas())
    if (p.x !== current.x || p.y !== current.y) win.setPosition(p.x, p.y)
    savePos()
  }
  if (geometry.roamBlocked || geometry.status !== 'idle') cancelRoam()
  if (frameFresh) completeRecovery()
}
function completeRecovery() {
  rendererReady = true
  recoveryReloaded = false
  if (recovery) { bootLog('recovery complete: ' + recovery.reason); recovery = null }
}
function tickPointer() {
  if (!validWin() || suspended || !win.isVisible()) return
  const p = screen.getCursorScreenPoint()
  const b = win.getBounds()
  // 用**迟滞版**判定：已经在交互态时，要离开她更远才恢复穿透。
  // 这样掩码每 1.2 秒重采带来的边缘像素翻转**不会**传到窗口状态
  // （见 HIT_HYSTERESIS_CSS 的注释：这是"点不到、拖不动"的真因）。
  const kind = hitKindSticky(p.x - b.x, p.y - b.y, lastIgnore === false)
  if (kind !== 'none') cancelRoam()
  // Clear an already-enabled passthrough as well when geometry expires.
  if (!drag) {
    // 判定依据一起记下（见 setIgnoreMouse 注释）：这样"她点不到"时能直接分清
    // 是命中算错还是鼠标没到，不用再靠猜。
    //
    // `mask=` 是**掩码版本号**（页面每次重采掩码都会变，周期 MASK_REFRESH_MS=1200ms）。
    // 为什么要记它：真机上出现过"**同一个光标坐标**、同一个 fresh=true，
    // 却在 hit=model / hit=none 之间来回翻" —— 有版本号就能一眼看出
    // 到底是"掩码重采导致判定翻转"还是别的原因在抖。
    const fresh = geometryFresh() && !recovery
    setIgnoreMouse(fresh ? kind === 'none' : false,
      'cursor=' + Math.round(p.x - b.x) + ',' + Math.round(p.y - b.y) + ' hit=' + kind
      + ' fresh=' + fresh + ' mask=' + (geometry ? geometry.maskAt : '-'))
  }
  if (!pointer || pointer.x !== p.x || pointer.y !== p.y) {
    pointer = p
    const display = screen.getDisplayNearestPoint(p).bounds
    win.webContents.send('pet-cursor', {
      x: (p.x - display.x) / Math.max(1, display.width), y: (p.y - display.y) / Math.max(1, display.height),
    })
  }
}
function applyMove() {
  moveTimer = null
  if (!drag || !pendingMove || !validWin()) return
  const delta = pendingMove
  pendingMove = null
  const next = advanceDrag(drag, delta.dx, delta.dy, movementBody(), areas())
  if (next) win.setBounds(next)
}
function endDrag(delta) {
  if (!drag) return
  if (delta && Number.isFinite(delta.dx) && Number.isFinite(delta.dy)) pendingMove = delta
  clearTimeout(moveTimer)
  applyMove()
  drag = null
  savePos()
  cancelRoam()
  bootLog('drag-end')
}
function tickRoam() {
  if (!validWin() || suspended || recovery || petHidden || !win.isVisible() || !rendererReady || Date.now() > geometryUntil || lowPower
    || !settings().roaming || drag || focusInput || !geometry || geometry.roamBlocked || geometry.status !== 'idle') return
  const now = Date.now()
  if (!roam) {
    if (now < nextRoamAt) return
    const bounds = win.getBounds()
    const display = screen.getDisplayNearestPoint({ x: Math.round(bounds.x + body.x + body.w / 2), y: Math.round(bounds.y + body.y + body.h / 2) }).workArea
    const target = clampWindow({
      x: display.x + 12 + Math.random() * Math.max(0, display.width - body.w - 24) - body.x,
      y: display.y + 12 + Math.random() * Math.max(0, display.height - body.h - 24) - body.y,
    }, movementBody(), [display])
    const distance = Math.hypot(target.x - bounds.x, target.y - bounds.y)
    roam = { from: bounds, target, start: now, duration: Math.max(2000, distance / 55 * 1000) }
  }
  const t = Math.min(1, (now - roam.start) / roam.duration)
  const smooth = t * t * (3 - 2 * t)
  const next = clampWindow({ x: roam.from.x + (roam.target.x - roam.from.x) * smooth,
    y: roam.from.y + (roam.target.y - roam.from.y) * smooth }, movementBody(), areas())
  const b = win.getBounds()
  if (next.x !== b.x || next.y !== b.y) win.setBounds({ ...next, width: roam.from.width, height: roam.from.height })
  if (t === 1) { savePos(); cancelRoam(20000 + Math.random() * 25000) }
}
async function openDsh() {
  await link.refresh()
  const state = link.status()
  if (state.connected) await shell.openExternal(state.base + '/')
  else await dialog.showMessageBox(win, { type: 'info', title: '连接 DSH', message: '请先打开 DSH。桌宠会自动连接；你仍然可以在桌面上和她互动。' })
}
function setInputFocus(want, activate = false) {
  if (!validWin() || (want && petHidden) || (!want && composing && !petHidden)) return
  const changed = focusInput !== want
  if (changed) {
    focusInput = want
    win.setFocusable(want)
    bootLog('focus ' + (want ? 'ON' : 'off'))
  }
  if (want) {
    cancelRoam()
    setIgnoreMouse(false)
    // focusin caused by win.focus() must not call win.focus()/setFocusable() again.
    if (changed || activate) {
      if (!win.isFocused()) win.focus()
      win.webContents.focus()
    }
  }
}
function showPet(force = false) {
  if (!validWin()) return
  if (!petHidden && win.isVisible() && !force) return
  petHidden = false
  geometryUntil = 0
  lastIgnore = null
  setIgnoreMouse(false)
  if (!win.isVisible()) win.showInactive()
  win.setAlwaysOnTop(true, 'screen-saver')
  win.webContents.send('pet-visibility', true)
  cancelRoam()
  syncTrayMenu()
  bootLog('visibility shown')
}
function hidePet() {
  if (!validWin() || petHidden) return
  petHidden = true
  endDrag()
  savePos()
  composing = false
  setInputFocus(false)
  geometry = null
  geometryUntil = 0
  setIgnoreMouse(false)
  win.webContents.send('pet-visibility', false)
  cancelRoam()
  syncTrayMenu()
  bootLog('visibility hidden')
}
/**
 * 重新载入她 —— 最后一道恢复手段。
 *
 * 为什么需要：真机事故（2026-10-13）里出现过"她看得见但点不动"，
 * 而唯一的恢复办法是**重启整个壳**。用户不该为了这个去杀进程。
 * 重载页面会重跑 `main()`：重建掩码、重新上报几何，等于把她重置一遍。
 * 也放在托盘里，因为那时候她可能已经点不到了（正好需要一条不依赖她的入口）。
 */
function reloadPet(automatic = false) {
  if (!validWin()) return
  if (automatic !== true) recoveryReloaded = false
  recovery = null
  endDrag()
  rendererReady = false
  geometry = null
  geometryUntil = 0
  lastIgnore = null
  setIgnoreMouse(false, 'reload')
  bootLog('reload pet')
  win.webContents.reload()
  syncTrayMenu()
}
/** 系统睡眠/唤醒后的自愈：清掉可能已经过期的几何，并强制恢复可交互。 */
function onPowerResume(kind, grace = 5000) {
  if (!validWin()) return
  suspended = false
  pendingMove = null
  endDrag()
  composing = false; focusInput = false
  win.setFocusable(false)
  rendererReady = false
  geometry = null
  geometryUntil = 0
  lastIgnore = null
  setIgnoreMouse(false, 'power-' + kind)
  pointer = null
  cancelRoam()
  bootLog('power ' + kind + ': geometry cleared, forcing interactive')
  // 位置也可能因为分辨率/显示器变化而落到屏幕外，夹回可见工作区。
  const cur = win.getBounds()
  const p = clampWindow({ x: cur.x, y: cur.y }, movementBody(), areas())
  if (p.x !== cur.x || p.y !== cur.y) win.setPosition(p.x, p.y)
  win.setAlwaysOnTop(true, 'screen-saver')
  if (!win.isVisible()) win.showInactive()
  if (typeof win.webContents.setBackgroundThrottling === 'function') win.webContents.setBackgroundThrottling(false)
  recovery = { id: ++recoverySequence, reason: kind, deadline: Date.now() + grace }
  win.webContents.send('pet-recovery', { id: recovery.id, expanded: !petHidden, reason: kind })
  win.webContents.focus()
  if (typeof win.webContents.invalidate === 'function') win.webContents.invalidate()
}
function onPowerSuspend(kind) {
  suspended = true
  pendingMove = null; endDrag(); cancelRoam(); savePos()
  recovery = null
  if (validWin()) win.webContents.send('pet-suspend')
  bootLog('power ' + kind + ': paused')
}
function tickRecovery() {
  if (shuttingDown || suspended || !rendererLoaded || !validWin()) return
  if (recovery) {
    if (Date.now() < recovery.deadline) return
    if (!recoveryReloaded) {
      recoveryReloaded = true
      bootLog('recovery timeout: ' + recovery.reason + ', reload once')
      reloadPet(true)
    } else {
      bootLog('recovery timeout after reload; keeping interactive')
      recovery = null
    }
    return
  }
  if (recoveryReloaded && !rendererReady) return
  if (!geometryFresh() || (!petHidden && frameObserved && Date.now() - lastFrameAt > 3000)) onPowerResume('watchdog')
}
function syncTrayMenu() {
  if (!tray) return
  const connected = link && link.status().connected
  const pref = settings().hostPref || 'auto'
  tray.setToolTip('鲸歌桌宠 · ' + (connected ? '已连接 DSH' : '独立陪伴'))
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: petHidden ? '展开大肥鱼' : '收起为大肥鱼', click: () => petHidden ? showPet() : hidePet() },
    { label: '自主漫游', type: 'checkbox', checked: !!settings().roaming, click: (item) => {
      updateSettings({ roaming: item.checked }); cancelRoam(item.checked ? 3000 : 20000); syncTrayMenu()
    } },
    { label: '回到屏幕右下角', click: () => {
      cancelRoam(); const a = screen.getPrimaryDisplay().workArea
      const p = clampWindow({ x: a.x + a.width - body.x - body.w - 16, y: a.y + a.height - body.y - body.h - 16 }, movementBody(), areas())
      win.setPosition(p.x, p.y); savePos(); showPet()
    } },
    { label: '低性能模式', type: 'checkbox', checked: lowPower, click: () => {
      lowPower = !lowPower; updateSettings({ lowPower }); cancelRoam()
      win.webContents.executeJavaScript('window.DSHPet && DSHPet.setLowPower(' + lowPower + ')').catch(() => {}); syncTrayMenu()
    } },
    { type: 'separator' },
    { label: '重新载入她', click: reloadPet },
    { type: 'separator' },
    { label: connected ? '已连接 DSH' : '等待 DSH · 自动重连', enabled: false },
    { label: '连接到', submenu: ['auto', 'desktop', 'web'].map((value, i) => ({
      label: ['自动', 'DSH 桌面版', 'DSH 网页版'][i], type: 'radio', checked: pref === value,
      click: async () => { updateSettings({ hostPref: value }); await link.refresh(); syncTrayMenu() },
    })) },
    { label: '打开 DSH 界面', click: openDsh },
    { type: 'separator' },
    { label: '彻底退出', click: () => app.quit() },
  ]))
}
function trusted(event) { return validWin() && event.sender === win.webContents }
function registerIPC() {
  if (typeof ipcMain.handle === 'function') ipcMain.handle('pet-diagnostics', (event) => {
    if (!trusted(event)) return null
    const bounds = win.getBounds()
    const cursor = screen.getCursorScreenPoint()
    const local = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
    return { bounds, cursor, local, hit: hitKind(local.x, local.y), ignore: lastIgnore,
      body, panels: geometry && geometry.panels, mask: geometry && geometry.mask && {
        w: geometry.mask.w, h: geometry.mask.h, solid: geometry.mask.grid.reduce((sum, on) => sum + !!on, 0) },
      drag: !!drag, focusInput, composing, collapsed: petHidden, visible: win.isVisible(), rendererReady,
      suspended, recovering: !!recovery, recoveryId: recoverySequence, renderAge: frameObserved ? Date.now() - lastFrameAt : null,
      geometryAge: Date.now() - (geometryUntil - 1500) }
  })
  ipcMain.on('pet-trace', (event, point) => {
    if (!trusted(event) || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    bootLog('input ' + String(point.type).slice(0, 20) + ' local=' + point.x + ',' + point.y
      + ' hit=' + hitKind(point.x, point.y) + ' ignore=' + lastIgnore)
  })
  ipcMain.on('pet-input', (event, data) => { if (trusted(event)) inputSnapshot(data) })
  ipcMain.on('pet-ready', (event, state) => {
    if (!trusted(event) || rendererAnnounced || !state || typeof state.collapsed !== 'boolean') return
    rendererAnnounced = true
    petHidden = state.collapsed
    syncTrayMenu()
    onPowerResume('renderer-ready')
  })
  ipcMain.on('pet-recover', (event, reason) => {
    if (!trusted(event) || suspended || recovery || !['visibility', 'context-restored', 'manual'].includes(reason)) return
    onPowerResume('renderer-' + reason)
  })
  ipcMain.on('pet-hover', (event, point) => {
    if (!trusted(event) || drag || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    // Forwarded renderer mouse coordinates can arrive late after moving/showing a window.
    // Both input paths must use the current OS cursor, or they fight over click-through.
    tickPointer()
  })
  ipcMain.on('drag-start', (event, point) => {
    if (!trusted(event) || !win.isVisible() || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || hitKind(point.x, point.y) !== (petHidden ? 'panel' : 'model')) return
    endDrag(); cancelRoam(); drag = beginDrag(win.getBounds()); setIgnoreMouse(false); bootLog('drag-start: hit=' + (petHidden ? 'tab' : 'model'))
  })
  ipcMain.on('drag-move', (event, delta) => {
    if (!trusted(event) || !drag || !delta || !Number.isFinite(delta.dx) || !Number.isFinite(delta.dy)) return
    pendingMove = delta
    if (!moveTimer) moveTimer = setTimeout(applyMove, 16)
  })
  ipcMain.on('drag-end', (event, delta) => { if (trusted(event)) endDrag(delta) })
  ipcMain.on('pet-focus', (event, on) => {
    if (!trusted(event)) return
    const want = on === true || !!(on && on.on === true)
    setInputFocus(want, !!(on && on.activate === true))
  })
  ipcMain.on('pet-composition', (event, on) => {
    if (!trusted(event) || petHidden) return
    composing = on === true
    if (composing) setIgnoreMouse(false)
  })
  ipcMain.on('shell-msg', async (event, message) => {
    if (!trusted(event)) return
    const value = String(message)
    if (value.startsWith('host:')) {
      const pref = value.slice(5)
      if (['auto', 'web', 'desktop'].includes(pref)) { updateSettings({ hostPref: pref }); await link.refresh(); syncTrayMenu() }
    } else if (value === 'collapse' || value === 'hide' || value === 'hidden') hidePet()
    else if (value === 'expand' || value === 'show' || value === 'shown') showPet()
    else if (value === 'open' || value === 'openDSH' || value === 'openDsh' || value === 'open-dsh') await openDsh()
    else if (value === 'quit') app.quit()
    else if (value === 'resetPos') {
      const a = screen.getPrimaryDisplay().workArea; const p = clampWindow({ x: a.x + a.width - body.x - body.w - 16, y: a.y + a.height - body.y - body.h - 16 }, movementBody(), areas())
      win.setPosition(p.x, p.y); savePos()
    } else if (value === 'lowPower') {
      lowPower = !lowPower; updateSettings({ lowPower })
      win.webContents.executeJavaScript('window.DSHPet && DSHPet.setLowPower(' + lowPower + ')').catch(() => {}); syncTrayMenu()
    }
  })
}
async function start() {
  lowPower = !!settings().lowPower
  if (settings().roaming === undefined) updateSettings({ roaming: true })
  link = createDshLink({ preference: () => settings().hostPref || 'auto' })
  await link.start()
  server = await startPetServer({ repoRoot: resolveRepoRoot(path.resolve(__dirname, '..', '..')), dshLink: link,
    ownerPath: OWNER_PATH, ownerActive: () => rendererReady && validWin() && link.status().connected
      && (petHidden || suspended || geometryFresh()) })
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H, frame: false, transparent: true, resizable: false,
    hasShadow: false, skipTaskbar: true, focusable: false, show: false, title: 'DS 鲸鱼娘桌宠',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenuBarVisibility(false)
  setIgnoreMouse(true)
  const a = screen.getPrimaryDisplay().workArea
  const initial = restorePosition(readJSON(path.join(app.getPath('userData'), 'pos.json'), null), movementBody(), areas(),
    { x: a.x + a.width - body.x - body.w - 16, y: a.y + a.height - body.y - body.h - 16 })
  win.setPosition(initial.x, initial.y)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(server.petBase + '/dsh-pet/app')) event.preventDefault() })
  win.webContents.on('did-start-loading', () => { rendererLoaded = false; rendererAnnounced = false; frameObserved = false; recovery = null })
  win.webContents.on('did-finish-load', () => {
    rendererLoaded = true
    rendererReady = false; geometry = null
    win.webContents.executeJavaScript('window.DSHPet && DSHPet.setLowPower(' + lowPower + ')').catch(() => {})
    onPowerResume('startup', 20000)
  })
  // 渲染进程挂了：几何全失效 → 强制可交互（别让她变成一块点不到的东西）
  win.webContents.on('render-process-gone', () => { rendererReady = false; geometry = null; endDrag(); lastIgnore = null; setIgnoreMouse(false) })
  // Keep DOM input eligibility across OS blur; a later click explicitly reactivates it.
  win.on('blur', () => { composing = false })
  win.on('closed', () => { win = null; app.quit() })
  win.once('ready-to-show', () => { showPet(); bootLog('ready-to-show') })
  registerIPC()
  const icon = nativeImage.createFromPath(path.join(resolveRepoRoot(), 'desktop', 'windows', 'build', 'icon.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.on('click', () => showPet(true))
  link.onChange((state) => { bootLog('DSH ' + (state.connected ? 'connected: ' + state.base : 'disconnected')); cancelRoam(); syncTrayMenu() })
  syncTrayMenu()
  claimOwner()
  timers.push(setInterval(tickPointer, 40), setInterval(tickRoam, 33), setInterval(tickRecovery, 1000))
  screen.on('display-metrics-changed', () => {
    if (!validWin()) return
    endDrag(); cancelRoam(); const p = clampWindow(win.getBounds(), movementBody(), areas()); win.setPosition(p.x, p.y); savePos()
  })
  screen.on('display-removed', () => {
    if (!validWin()) return
    endDrag(); cancelRoam(); const p = clampWindow(win.getBounds(), movementBody(), areas()); win.setPosition(p.x, p.y); savePos()
  })
  // 系统睡眠/唤醒：显示几何、DPI、合成器都可能变，页面快照也可能停更。
  // 不处理的话穿透可能卡在"整窗穿透"，表现就是**她看得见但点不动**，
  // 而唯一的恢复办法是重启壳（真机事故 2026-10-13）。这里清掉过期几何并强制可交互。
  // 用 powerMonitor 而不是"猜"：resume / unlock-screen 都是明确的系统事件。
  try {
    powerMonitor.on('suspend', () => onPowerSuspend('suspend'))
    powerMonitor.on('lock-screen', () => onPowerSuspend('lock'))
    powerMonitor.on('resume', () => onPowerResume('resume'))
    powerMonitor.on('unlock-screen', () => onPowerResume('unlock'))
  } catch (err) { bootLog('powerMonitor 不可用: ' + (err && err.message)) }
  await win.loadURL(server.petBase + '/dsh-pet/app')
  bootLog('started: ' + server.petBase + ' DSH=' + (link.status().base || 'offline'))
}
app.on('before-quit', () => {
  if (shuttingDown) return
  shuttingDown = true
  endDrag(); savePos(); timers.forEach(clearInterval); clearTimeout(moveTimer)
  try { releaseOwner() } catch (err) { bootLog('owner release: ' + err.message) }
  if (link) link.close()
  if (server) server.close()
  if (tray) tray.destroy()
})
app.on('window-all-closed', () => app.quit())
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => showPet(true))
  app.whenReady().then(start).catch((err) => { bootLog(err.stack || err.message); dialog.showErrorBox('鲸歌桌宠启动失败', err.message); app.quit() })
}
