'use strict'
// Source template. Generated into desktop/standalone/main.js by make-standalone-shell.mjs.
const { app, BrowserWindow, Tray, Menu, screen, shell, ipcMain, nativeImage, dialog } = require('electron')
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
let rendererReady = false
let lowPower = false
let roam = null
let nextRoamAt = Date.now() + 25000
let pointer = null
let geometryUntil = 0
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
function setIgnoreMouse(ignore) {
  if (!validWin() || lastIgnore === ignore || (drag && ignore)) return
  win.setIgnoreMouseEvents(ignore, { forward: true })
  lastIgnore = ignore
}
function hitKind(x, y) {
  if (!geometry) return 'none'
  const inside = (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
  if (geometry.panels.some(inside)) return 'panel'
  const m = geometry.mask
  if (!inside(body)) return 'none'
  if (!m) return 'model'
  const gx = Math.floor((x - body.x) * m.w / body.w)
  const gy = Math.floor((y - body.y) * m.h / body.h)
  // A few CSS pixels of tolerance around visible pixels; never enlarge the whole silhouette.
  const rx = Math.max(1, Math.ceil(5 * m.w / body.w))
  const ry = Math.max(1, Math.ceil(5 * m.h / body.h))
  for (let yy = Math.max(0, gy - ry); yy <= Math.min(m.h - 1, gy + ry); yy++) {
    for (let xx = Math.max(0, gx - rx); xx <= Math.min(m.w - 1, gx + rx); xx++) {
      if (m.grid[yy * m.w + xx]) return 'model'
    }
  }
  return 'none'
}
function cancelRoam(delay = 20000) { roam = null; nextRoamAt = Date.now() + delay }
function inputSnapshot(snapshot) {
  if (!snapshot || !snapshot.body || !Array.isArray(snapshot.panels)) return
  const rect = (r) => r && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(r[key])) && r.w > 0 && r.h > 0 && r.w < 2000 && r.h < 2000
  if (!rect(snapshot.body)) return
  const newBody = snapshot.body
  const changed = !geometry || Math.abs(body.x - newBody.x) > 2 || Math.abs(body.y - newBody.y) > 2
    || Math.abs(body.w - newBody.w) > 2 || Math.abs(body.h - newBody.h) > 2
  body = newBody
  const m = snapshot.mask
  const mask = m && Number.isInteger(m.w) && Number.isInteger(m.h) && m.w > 0 && m.h > 0 && m.w * m.h <= 65536
    && Array.isArray(m.grid) && m.grid.length === m.w * m.h ? m : geometry && geometry.mask
  geometry = { panels: snapshot.panels.filter(rect).slice(0, 32), mask, status: String(snapshot.status || 'idle'),
    roamBlocked: typeof snapshot.roamBlocked === 'boolean' ? snapshot.roamBlocked : snapshot.panels.length > 0 }
  if (typeof snapshot.lowPower === 'boolean') lowPower = snapshot.lowPower
  rendererReady = true
  geometryUntil = Date.now() + 1500
  if (changed && !drag && validWin()) {
    const saved = readJSON(path.join(app.getPath('userData'), 'pos.json'), null)
    const current = win.getBounds()
    const p = restorePosition(saved, body, areas(), current)
    win.setPosition(p.x, p.y)
  }
  if (geometry.roamBlocked || geometry.status !== 'idle') cancelRoam()
}
function tickPointer() {
  if (!validWin() || !win.isVisible()) return
  const p = screen.getCursorScreenPoint()
  const b = win.getBounds()
  const kind = hitKind(p.x - b.x, p.y - b.y)
  if (kind !== 'none') cancelRoam()
  if (!drag) setIgnoreMouse(kind === 'none')
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
  const next = advanceDrag(drag, delta.dx, delta.dy, body, areas())
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
  if (!validWin() || !win.isVisible() || !rendererReady || Date.now() > geometryUntil || lowPower
    || !settings().roaming || drag || focusInput || !geometry || geometry.roamBlocked || geometry.status !== 'idle') return
  const now = Date.now()
  if (!roam) {
    if (now < nextRoamAt) return
    const bounds = win.getBounds()
    const display = screen.getDisplayNearestPoint({ x: Math.round(bounds.x + body.x + body.w / 2), y: Math.round(bounds.y + body.y + body.h / 2) }).workArea
    const target = clampWindow({
      x: display.x + 12 + Math.random() * Math.max(0, display.width - body.w - 24) - body.x,
      y: display.y + 12 + Math.random() * Math.max(0, display.height - body.h - 24) - body.y,
    }, body, [display])
    const distance = Math.hypot(target.x - bounds.x, target.y - bounds.y)
    roam = { from: bounds, target, start: now, duration: Math.max(2000, distance / 55 * 1000) }
  }
  const t = Math.min(1, (now - roam.start) / roam.duration)
  const smooth = t * t * (3 - 2 * t)
  const next = clampWindow({ x: roam.from.x + (roam.target.x - roam.from.x) * smooth,
    y: roam.from.y + (roam.target.y - roam.from.y) * smooth }, body, areas())
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
function showPet() {
  if (!validWin()) return
  win.showInactive()
  win.setAlwaysOnTop(true, 'screen-saver')
  win.webContents.executeJavaScript("document.querySelector('.dshp-root.dshp-hidden') && window.DSHPet && DSHPet.setHidden(false)").catch(() => {})
  cancelRoam()
  syncTrayMenu()
}
function hidePet() {
  if (!validWin()) return
  endDrag()
  win.hide()
  cancelRoam()
  syncTrayMenu()
}
function syncTrayMenu() {
  if (!tray) return
  const connected = link && link.status().connected
  const pref = settings().hostPref || 'auto'
  tray.setToolTip('鲸歌桌宠 · ' + (connected ? '已连接 DSH' : '独立陪伴'))
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: validWin() && win.isVisible() ? '隐藏桌宠' : '显示桌宠', click: () => validWin() && win.isVisible() ? hidePet() : showPet() },
    { label: '自主漫游', type: 'checkbox', checked: !!settings().roaming, click: (item) => {
      updateSettings({ roaming: item.checked }); cancelRoam(item.checked ? 3000 : 20000); syncTrayMenu()
    } },
    { label: '回到屏幕右下角', click: () => {
      cancelRoam(); const a = screen.getPrimaryDisplay().workArea
      const p = clampWindow({ x: a.x + a.width - body.x - body.w - 16, y: a.y + a.height - body.y - body.h - 16 }, body, areas())
      win.setPosition(p.x, p.y); savePos(); showPet()
    } },
    { label: '低性能模式', type: 'checkbox', checked: lowPower, click: () => {
      lowPower = !lowPower; updateSettings({ lowPower }); cancelRoam()
      win.webContents.executeJavaScript('window.DSHPet && DSHPet.setLowPower(' + lowPower + ')').catch(() => {}); syncTrayMenu()
    } },
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
  ipcMain.on('pet-input', (event, data) => { if (trusted(event)) inputSnapshot(data) })
  ipcMain.on('pet-hover', (event, point) => {
    if (!trusted(event) || drag || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    const kind = hitKind(point.x, point.y)
    if (kind !== 'none') cancelRoam()
    setIgnoreMouse(kind === 'none')
  })
  ipcMain.on('drag-start', (event, point) => {
    if (!trusted(event) || !win.isVisible() || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || hitKind(point.x, point.y) !== 'model') return
    endDrag(); cancelRoam(); drag = beginDrag(win.getBounds()); setIgnoreMouse(false); bootLog('drag-start: hit=model')
  })
  ipcMain.on('drag-move', (event, delta) => {
    if (!trusted(event) || !drag || !delta || !Number.isFinite(delta.dx) || !Number.isFinite(delta.dy)) return
    pendingMove = delta
    if (!moveTimer) moveTimer = setTimeout(applyMove, 16)
  })
  ipcMain.on('drag-end', (event, delta) => { if (trusted(event)) endDrag(delta) })
  ipcMain.on('pet-focus', (event, on) => {
    if (!trusted(event)) return
    focusInput = on === true
    win.setFocusable(focusInput)
    if (focusInput) { cancelRoam(); setIgnoreMouse(false); win.focus() }
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
      const a = screen.getPrimaryDisplay().workArea; const p = clampWindow({ x: a.x + a.width - body.x - body.w - 16, y: a.y + a.height - body.y - body.h - 16 }, body, areas())
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
    ownerPath: OWNER_PATH, ownerActive: () => rendererReady && Date.now() < geometryUntil && validWin() && link.status().connected })
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H, frame: false, transparent: true, resizable: false,
    hasShadow: false, skipTaskbar: true, focusable: false, show: false, title: 'DS 鲸鱼娘桌宠',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenuBarVisibility(false)
  setIgnoreMouse(true)
  const a = screen.getPrimaryDisplay().workArea
  const initial = restorePosition(readJSON(path.join(app.getPath('userData'), 'pos.json'), null), body, areas(),
    { x: a.x + a.width - body.x - body.w - 16, y: a.y + a.height - body.y - body.h - 16 })
  win.setPosition(initial.x, initial.y)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(server.petBase + '/dsh-pet/app')) event.preventDefault() })
  win.webContents.on('did-finish-load', () => {
    rendererReady = false; geometry = null
    win.webContents.executeJavaScript('window.DSHPet && DSHPet.setLowPower(' + lowPower + ')').catch(() => {})
  })
  win.webContents.on('render-process-gone', () => { rendererReady = false; geometry = null; endDrag(); setIgnoreMouse(true) })
  win.on('blur', () => { if (focusInput) { focusInput = false; win.setFocusable(false) } })
  win.on('closed', () => { win = null; app.quit() })
  win.once('ready-to-show', () => { showPet(); bootLog('ready-to-show') })
  registerIPC()
  const icon = nativeImage.createFromPath(path.join(resolveRepoRoot(), 'desktop', 'windows', 'build', 'icon.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.on('click', showPet)
  link.onChange((state) => { bootLog('DSH ' + (state.connected ? 'connected: ' + state.base : 'disconnected')); cancelRoam(); syncTrayMenu() })
  syncTrayMenu()
  claimOwner()
  timers.push(setInterval(tickPointer, 40), setInterval(tickRoam, 33))
  screen.on('display-metrics-changed', () => {
    if (!validWin()) return
    endDrag(); cancelRoam(); const p = clampWindow(win.getBounds(), body, areas()); win.setPosition(p.x, p.y); savePos()
  })
  screen.on('display-removed', () => {
    if (!validWin()) return
    endDrag(); cancelRoam(); const p = clampWindow(win.getBounds(), body, areas()); win.setPosition(p.x, p.y); savePos()
  })
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
  app.on('second-instance', showPet)
  app.whenReady().then(start).catch((err) => { bootLog(err.stack || err.message); dialog.showErrorBox('鲸歌桌宠启动失败', err.message); app.quit() })
}
