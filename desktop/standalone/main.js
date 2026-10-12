// DS 鲸鱼娘桌宠 · Windows 桌面外壳
// ————————————————————————————————————————————————————————————
// 和 macOS 版同一个思路：**她本身还是那份插件**（模型、联动、菜单、钱包都在插件里），
// 这个程序只是一个透明、无边框、永远置顶的窗口，加载插件提供的那一页。
//
// Windows 上比 macOS 容易的地方：Electron 自带跨平台，不用担心 App Nap、私有 API 那类坑。
// 需要注意的只有三件：
//   ① 点击穿透：setIgnoreMouseEvents(true, { forward: true }) + 我们自己定时问页面「鼠标下面是不是她」
//   ② 本机通行证：插件的 /dsh-pet/* 要过信任栅栏，所以把 ~/.dsh 里那张通行证写成 cookie
//   ③ 打字：Electron 窗口默认可聚焦，不用像 macOS 那样覆写 canBecomeKey
//
// 另外按主人要求做了「联动」：第一次打开时如果检测不到插件，会直接给一个
// 「一键安装插件」按钮，替你跑 dsh plugin --profile web add github:...，
// 所以 Windows 用户不需要自己开命令行。
const { createShaper } = require('./window-shape.cjs')
const { app, BrowserWindow, Tray, Menu, screen, shell, session, ipcMain, nativeImage, dialog } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { exec } = require('node:child_process')

// 宿主地址在启动时「发现」出来，不再写死 —— 与 macOS 版保持一致：
// 官方桌面版（Electron，端口由宿主决定，实测 19387）和手动起的 `dsh web`（3080）都要能连上。
const CANDIDATE_BASES = [
  'http://127.0.0.1:19387',
  'http://127.0.0.1:3080',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:3000',
]
let petBase = CANDIDATE_BASES[0]

// 连接档位：auto（默认）/ desktop（官方桌面版）/ web（dsh web）
// 主人反馈：她有时连网页版、有时连桌面版 → 会「串对话」，所以要能钉住并记住。
function hostPref() {
  try {
    const p = path.join(app.getPath('userData'), 'settings.json')
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).hostPref
    return v === 'desktop' || v === 'web' ? v : 'auto'
  } catch (e) {
    return 'auto'
  }
}
function setHostPref(v) {
  try {
    const p = path.join(app.getPath('userData'), 'settings.json')
    let cur = {}
    try {
      cur = JSON.parse(fs.readFileSync(p, 'utf8')) || {}
    } catch (e) {}
    cur.hostPref = v
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(cur, null, 2))
  } catch (e) {}
}

/** 通行证文件里记录的宿主端口（插件写的，因机器而异 —— 不能写死） */
function deskPort() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
    const n = Number(j.port)
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
  } catch (e) {
    return null
  }
}
// 壳专用页面（她本体，带壳能力的完整版）；浏览器里那个 standalone/ 是给外人看的 demo 页
const petURL = () => petBase + '/dsh-pet/app'
const PLUGIN = 'github:Andersen216/dsh-whale-girl-live2d'
// 同 macOS：窗口要装得下她 + 四周的面板（透明区域点击穿透，不挡别的窗口）
const WIN_W = Number(process.env.DSHW_PET_W || 420) // 窗口只是"画布"：她只占右下角一块，其余是透明的
const WIN_H = Number(process.env.DSHW_PET_H || 600) // 别比屏幕可视区还高（实测：900 高在可视 1019 的屏上，往上拖会被"夹回"挡住，像被关在框里）
const BALL = 62
const TOKEN_FILE = path.join(os.homedir(), '.dsh', 'dsh-live2d-pet-desktop.json')

let win = null
let ballWin = null
let tray = null
let pollTimer = null
let cursorFeed = null
let lastCursor = null
let dragTimer = null
let dragFrom = null
// 贴边小球单独一份拖动状态：原来和主窗口共用 dragFrom，收起状态下按小球会把
// 已经 hide() 的主窗口一路搬走（B站/PR 反馈的真实 bug）
let ballDrag = null
let collapsed = false
let lowPower = false
let overPanel = false
let failCount = 0
let lastHit = 'none'

// ——————————————————————————————————————————————————————————————
// 通行证：插件启动时会写 ~/.dsh/dsh-live2d-pet-desktop.json
// ——————————————————————————————————————————————————————————————
function readToken() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
    return typeof j.token === 'string' && j.token.length >= 16 ? j.token : null
  } catch (e) {
    return null
  }
}

async function setTokenCookie() {
  const token = readToken()
  if (!token) return false
  try {
    await session.defaultSession.cookies.set({
      url: petBase,
      name: 'dsh_pet_desk',
      value: token,
      domain: '127.0.0.1',
      path: '/',
      secure: false,
      httpOnly: false,
    })
    return true
  } catch (e) {
    return false
  }
}

// ——————————————————————————————————————————————————————————————
// 判断「鼠标下面是什么」：她本体 / 她的面板 / 空白
// ——————————————————————————————————————————————————————————————
const hitJS = (x, y) => `(function(){try{
  var el=document.elementFromPoint(${x},${y});
  var ui=!!(el&&el.closest&&el.closest('.dshp-panel,.dshp-menu,.dshp-hud,.dshp-bubble,.dshp-composer,.dshp-dock,.dshp-tab,.dshp-mail'));
  if(ui) return 'panel';
  if(window.DSHPet&&DSHPet.hitTest&&DSHPet.hitTest(${x},${y})) return 'model';
  return 'none';
}catch(e){return 'none'}})()`

function setIgnore(on) {
  if (!win || win.isDestroyed()) return
  win.setIgnoreMouseEvents(on, { forward: true })
}

async function poll() {
  if (!win || win.isDestroyed() || !win.isVisible()) return
  const p = screen.getCursorScreenPoint()
  const b = win.getBounds()
  if (p.x < b.x || p.x > b.x + b.width || p.y < b.y || p.y > b.y + b.height) {
    lastHit = 'none'
    setIgnore(true)
    return
  }
  if (dragTimer) return // 拖动中不抢事件（否则鼠标一离开她就变穿透，拖动会断）
  try {
    const kind = await win.webContents.executeJavaScript(hitJS(Math.round(p.x - b.x), Math.round(p.y - b.y)))
    lastHit = kind
    overPanel = kind === 'panel'
    setIgnore(kind === 'none')
    // 拖动诊断：回答"为什么有时候抓不住她"。每 400ms 最多一行，很便宜。
    const nowMs = Date.now()
    if (nowMs - (globalThis.__dragDiagAt || 0) > 400) {
      globalThis.__dragDiagAt = nowMs
      bootLog('diag: cursor=' + p.x + ',' + p.y + ' local=' + Math.round(p.x - b.x) + ',' + Math.round(p.y - b.y) + ' hit=' + kind + ' ignore=' + (kind === 'none'))
    }
  } catch (e) {
    setIgnore(true)
  }
}

// ——————————————————————————————————————————————————————————————
// 主窗口
// ——————————————————————————————————————————————————————————————

/** 可选的「铺满主屏」：来自 PR #7（@c1overzz）。默认关闭 —— 读不到/解析失败/不是 true 一律 false。
 *  打开方式：在 userData 目录（Windows 通常是 %APPDATA%\DS-WhaleGirl-Pet）的
 *  settings.json 里写 {"fullscreenPrimary": true}。开启后窗口覆盖主屏工作区，
 *  空白处照旧点击穿透（setIgnoreMouseEvents 逻辑不变），于是「她在哪」不再受窗口边界约束。 */
/**
 * 是否启用「窗口成型」（把窗口裁成她的轮廓）。**默认关闭**：
 * 目前区域与她的实际渲染位置还有偏差（实测约 100px，会把她裁掉一大半），见 README。
 * 打开方式：%APPDATA%\DS-WhaleSong-Pet\settings.json 写 {"shapeWindow": true}。
 */
function readShapeWindow() {
  try {
    const p = path.join(app.getPath('userData'), 'settings.json')
    return JSON.parse(fs.readFileSync(p, 'utf8')).shapeWindow === true
  } catch (err) { return false }
}

function readFullscreenPrimary() {
  try {
    const p = path.join(app.getPath('userData'), 'settings.json')
    return JSON.parse(fs.readFileSync(p, 'utf8')).fullscreenPrimary === true
  } catch (e) {
    return false
  }
}

function createMain() {
  const FULLSCREEN_PRIMARY = readFullscreenPrimary()
  const waFs = screen.getPrimaryDisplay().workArea
  win = new BrowserWindow({
    width: FULLSCREEN_PRIMARY ? waFs.width : WIN_W,
    height: FULLSCREEN_PRIMARY ? waFs.height : WIN_H,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    title: 'DS 鲸鱼娘桌宠',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false, // 她不能被后台降频（不然会像卡住）
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // —— 穿透机制：默认走上游那套（整窗穿透 + 90ms 轮询按需关掉）——
  // 「窗口成型」（settings.json: shapeWindow=true）是另一条路：把窗口裁成她的轮廓，
  // 轮廓之外根本不算窗口。两者**互斥**：成型开着时应改用下面这行注释掉的形式
  // （否则连她身上也点不到）；成型关着时必须保留整窗穿透，否则矩形窗口会挡住鼠标。
  win.setIgnoreMouseEvents(true, { forward: true })
  win.setMenuBarVisibility(false)

  const wa = screen.getPrimaryDisplay().workArea
    // —— 独立壳改动 ⑦：把窗口右下角钉在屏幕右下角 ——
    // 她在窗口内是靠右下角渲染的，所以钉住右下角 = 把她固定在"离屏幕角 OFFSET 像素"处；
    // 窗口左上角伸出屏幕多少都不影响她（那块本来就是透明的），而且窗口越小越好拖。
    const OFFSET = 12
    win.setPosition(wa.x + wa.width - WIN_W - OFFSET, wa.y + wa.height - WIN_H - OFFSET)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('did-finish-load', () => {
    failCount = 0
    win.webContents.executeJavaScript('window.DSHPet && DSHPet.setLowPower && DSHPet.setLowPower(' + lowPower + ')')
    win.webContents.executeJavaScript("window.DSHPet && DSHPet.setHostPref && DSHPet.setHostPref('" + hostPref() + "')").catch(() => {}).catch(() => {})
    setTimeout(() => win.webContents.executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)').catch(() => {}), 1200)
    setTimeout(() => win.webContents.executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)').catch(() => {}), 3000)
  })
  win.webContents.on('did-fail-load', () => {
    failCount++
    if (failCount >= 3) showHint()
    setTimeout(load, 5000)
  })
  // 窗口移动：越界就拉回来（拔掉外接屏 / 改分辨率后可能跑到屏幕外），
  // 写盘节流到 400ms —— 原来每个 moved 事件都写一次，拖动时非常费（PR 反馈）
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    const [cx, cy] = clampToDisplays(x, y)
    if (cx !== x || cy !== y) win.setPosition(cx, cy)
    const now = Date.now()
    if (now - (globalThis.__lastSaveAt || 0) > 400) {
      globalThis.__lastSaveAt = now
      savePos()
    }
  })
  win.on('closed', () => { win = null })

  // 拖动：页面里按下她 → 交给主进程搬窗口（拖动期间用 16ms 快速轮询，跟手）
  // 抓手偏移：按下时算一次「指针 − 窗口左上角」，之后 位置 = 指针 − 偏移（follow 语义）。
  // 两者都是 Electron 的 DIP 坐标（实测 scaleFactor=1.5 时同尺度），可直接相减。
  async function grabOffset() {
    try {
      const p = screen.getCursorScreenPoint()
      const [wx, wy] = win.getPosition()
      return { x: p.x - wx, y: p.y - wy }
    } catch (err) {
      return { x: 0, y: 0 }
    }
  }

  ipcMain.on('drag-start', async (_e, at) => {
    // 小球用的是同一个 preload，也会发 drag-start；主窗口只是 hide() 没 destroy()，
    // 不加这条守卫就会把看不见的主窗口搬走（PR 反馈）
    if (!win || win.isDestroyed() || !win.isVisible()) return
    // ⚠️ 不能直接用 overPanel（那是 90ms 轮询的上一次结果）：
    // 按下那一刻它恰好是 panel 时，这次拖动就被让给网页，只能在窗口内挪、整个窗口搬不动。
    // B 站 @F0rsEn 反馈的正是这条。改成「按下瞬间重新判一次」，几十毫秒的等待对拖动没影响。
    try {
      const b = win.getBounds()
      const kind = await win.webContents.executeJavaScript(
        hitJS(Math.round(at.x - b.x), Math.round(at.y - b.y)),
      )
      if (kind === 'panel') return // 真控件（滑块/按钮/输入框）→ 让给网页
    } catch (e) {}
    dragFrom = { grab: await grabOffset(), n: 0, lastX: NaN, lastY: NaN }
    clearInterval(dragTimer)
    dragTimer = setInterval(() => {
      if (!dragFrom || !win) return
      const p = screen.getCursorScreenPoint()
      const wantX = Math.round(p.x - dragFrom.grab.x)
            const wantY = Math.round(p.y - dragFrom.grab.y)
            // ⚠️ 性能（实测这台机器）：**透明窗口**的 setPosition 要 6.5ms（不透明只要 2.9ms）；
            //   而原来这里是 16ms 一帧（60fps）→ 实测 60 帧拖了 1680ms（理想 960ms，超支 75%），
            //   帧持续积压 = 用户看到的"晃 / 闪 / 轨迹不稳"。所以：
            //   ① 位置没变就不调（省一半：3.1ms/次）；
            //   ② 帧率降到 30fps（33ms）—— 60fps 在这台机器上根本供不起。
            if (wantX === dragFrom.lastX && wantY === dragFrom.lastY) return
            dragFrom.lastX = wantX
            dragFrom.lastY = wantY
            win.setPosition(wantX, wantY)
            // 拖动轨迹诊断（只记前 80 帧）：want vs got 不一致就说明有东西把窗口挪回去了
            try {
              if (dragFrom.n < 80) {
                dragFrom.n++
                const got = win.getPosition()
                bootLog('drag: cur=' + p.x + ',' + p.y + ' want=' + wantX + ',' + wantY + ' got=' + got[0] + ',' + got[1] + (got[0] !== wantX || got[1] !== wantY ? ' <-- 被挪走' : ''))
              }
            } catch (err) {}
    }, 33)
    win.webContents.executeJavaScript("document.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}))").catch(() => {})
  })
  ipcMain.on('drag-end', () => {
    clearInterval(dragTimer)
    dragTimer = null
    dragFrom = null
    savePos()
  })
  // 前端那个 ↗ 符号：用默认浏览器打开 DSH 界面
  ipcMain.on('install-plugin', () => installPlugin())
  // 前端（pet.js）发来的指令，和 macOS 版一一对应。
  // ⚠️ 每条都带状态守卫：macOS 版在这里踩过无限递归的坑（expand 后又收到 shown 再 expand，
  //    日志炸到 5472 万行、CPU 打满），Windows 版一开始就不留这个隐患。
  ipcMain.on('shell-msg', (_e, msg) => {
    switch (msg) {
      case 'hidden':
      case 'collapse':
        if (!collapsed) collapse()
        break
      case 'shown':
      case 'expand':
        if (collapsed) expand()
        break
      case 'host:auto':
      case 'host:desktop':
      case 'host:web':
        setHostPref(msg.slice(5))
        bootLog('连接档位切成 ' + msg.slice(5) + ' → 重新发现宿主')
        load()
        break
      case 'open-dsh':
        shell.openExternal(petBase + '/')
        break
      case 'quit':
        app.quit()
        break
    }
  })

  load()
  // ——— 全屏视线追踪 ———
  // 页面只能看到窗口内的鼠标；窗口外的移动它收不到 → 她"不看你鼠标"。
  // 用 Electron 原生 sendInputEvent 把全局光标位置喂进去（比 executeJavaScript 省得多）。
  cursorFeed = setInterval(() => {
    try {
      if (!win || win.isDestroyed() || !win.isVisible() || dragTimer) return
      const p = screen.getCursorScreenPoint()
      // 与 macOS 同理：原来 60ms + 3px 死区会让视线目标「跳着给」，看着卡
      if (lastCursor && Math.abs(lastCursor.x - p.x) < 1 && Math.abs(lastCursor.y - p.y) < 1) return
      lastCursor = p
      const b = win.getBounds()
      // 把「整个屏幕」映射到窗口坐标里（与 macOS 同理）：
      // 否则鼠标跑到窗口外就会被夹住，看着像「到屏幕边缘就不跟了」。
      const disp = screen.getDisplayNearestPoint(p).bounds
      const nx = (p.x - disp.x) / Math.max(1, disp.width)
      const ny = (p.y - disp.y) / Math.max(1, disp.height)
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(nx * b.width),
        y: Math.round(ny * b.height),
      })
    } catch (e) {}
  }, 16)
  pollTimer = setInterval(poll, 90)
  bootLog('拖动脉冲轮询已启动（90ms）')
  win.once('ready-to-show', () => {
    bootLog('ready-to-show：窗口即将显示')
    bootLog('ready-to-show')
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
  })
}

/**
 * 发现正在运行的 DSH 宿主：官方桌面版（19387）或 `dsh web`（3080）。
 * 带通行证探 /dsh-pet/pet.js：200 = 就是它；401 = 插件在但票不对（也先进去）。
 * 以前写死 3080，导致只开官方桌面版的用户连不上。
 */
/**
 * —— 独立模式改动 ④：只找 **DSH 宿主**（我们自己的本地服务不参与）——
 * 上游那套 discoverHost 是"找到任何一个 /dsh-pet/pet.js 响应 200 的端口"，在独立壳里会
 * 找到**我们自己**。这里排除掉自己的端口，只认真的是 DSH 的宿主。
 */
async function discoverDshHost() {
  const myPort = petServer ? petServer.port : 0
  for (const base of CANDIDATE_BASES) {
    if (myPort && base.indexOf(':' + myPort) >= 0) continue
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 1200)
      const r = await fetch(base + '/dsh-pet/pet.js', { signal: ctrl.signal })
      clearTimeout(t)
      // 200 = 有插件；401 = 宿主在但票不对（也算 DSH 在跑）
      if (r.status === 200 || r.status === 401) return base
    } catch (err) {}
  }
  const port = deskPort()
  if (port && port !== myPort) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/dsh-pet/pet.js'); if (r.ok || r.status === 401) return 'http://127.0.0.1:' + port } catch (err) {}
  }
  const found = await scanListeningPorts ? null : null
  return null
}

async function discoverHost(token) {
  // 关键：**不靠端口号判断类型**（3080/19387 只是本机端口，别人可能完全不同）。
  // 判据是宿主自己发出的前端里的启动配置：
  //   跑在 Electron 里（官方桌面版）→ "desktop":true
  //   普通 Node（dsh web）         → "desktop":false
  const pref = hostPref()
  const scanned = await scanListeningPorts()
  const ordered = []
  const p = deskPort()
  if (p) ordered.push(p)
  for (const n of scanned) if (!ordered.includes(n)) ordered.push(n)
  for (const base of CANDIDATE_BASES) {
    const n = Number(base.split(':').pop())
    if (!ordered.includes(n)) ordered.push(n)
  }
  const okList = []
  let fallback = null
  for (const n of ordered) {
    const base = 'http://127.0.0.1:' + n
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 1800)
      const res = await fetch(base + '/dsh-pet/pet.js', {
        headers: { Cookie: 'dsh_pet_desk=' + token },
        signal: ctl.signal,
      })
      clearTimeout(timer)
      const text = res.status === 200 ? await res.text() : ''
      if (res.status === 200) {
        const desktop = /"desktop":true/.test(text) ? true : /"desktop":false/.test(text) ? false : null
        okList.push({ base, desktop })
        bootLog('候选宿主可用: ' + base + ' 类型=' + (desktop === true ? '桌面版' : desktop === false ? '网页版' : '未知'))
        continue
      }
      if (res.status === 401 && !fallback) fallback = base
    } catch (e) {}
  }
  let pick = null
  if (pref === 'desktop') pick = okList.find((x) => x.desktop === true)
  else if (pref === 'web') pick = okList.find((x) => x.desktop === false)
  if (!pick) pick = okList[0]
  if (pick) {
    bootLog('连上宿主（' + (pick.desktop === true ? '桌面版' : pick.desktop === false ? '网页版' : '未知类型') + '，按档位 ' + pref + '）: ' + pick.base)
    return pick.base
  }
  return fallback
}

// —— 独立模式改动 ①：本地迷你服务（静态资源 + SMTC），壳不再依赖 DSH ——
let petServer = null
let petShaper = null
async function startLocalServer() {
  // 窗口成型器：页面会把命中掩码 POST 上来，据此把窗口裁成她的轮廓。
  // getHwnd **每次现取**：窗口重建后句柄会变。
  if (!petShaper) {
    petShaper = createShaper({
      getHwnd: () => {
        try {
          if (!win || win.isDestroyed()) return null
          const buf = win.getNativeWindowHandle()
          return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : Number(buf.readUInt32LE(0))
        } catch (err) { return null }
      },
      // 阴影/光晕在掩码之外，往外交替膨胀几像素，免得被区域切掉（真机对比后再调）
      expand: 6,
      // 关键单位换算（实测）：页面给的是 CSS 像素 = DIP，而 SetWindowRgn 收**物理像素**。
      // 150% 缩放时不做这步，区域会小 1/1.5 倍并被推到窗口外（实测区域 = 期望 × 0.667）。
      getScale: () => {
        try {
          const b = win.getBounds()
          const d = screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) })
          return (d && d.scaleFactor) || 1
        } catch (err) { return 1 }
      },
      log: (m) => bootLog(m),
    })
  }
  const shaper = petShaper
  if (petServer) return petServer
  try {
    const mod = require('./server.cjs')
    petServer = await mod.startPetServer({ onShape: (shape) => { if (readShapeWindow()) return shaper.submit(shape); return { ok: false, error: 'disabled' } }, extra: process.resourcesPath ? path.join(process.resourcesPath, 'dsh-whale-song') : '' })
    bootLog('本地服务已起: ' + petServer.url + ' (root=' + petServer.repoRoot + ')')
    return petServer
  } catch (err) {
    bootLog('本地服务启动失败: ' + (err && err.stack ? err.stack : String(err)))
    return null
  }
}

async function load() {
  if (!win || win.isDestroyed()) return
  // —— 独立模式改动 ②b：**永远用我们自己起的本地服务** ——
  // 上游这里会 setTokenCookie() + discoverHost()，扫本机端口找正在跑的 DSH 并切过去。
  // 独立壳不需要 DSH；而且用户机器上通常**就有** DSH 在跑，那样会被"抢走"（实测踩过）。
  if (!petServer || !petServer.petBase) {
    const srv = await startLocalServer()
    if (!srv) { failCount++; if (failCount >= 1) showHint(); setTimeout(load, 5000); return }
  }
  petBase = petServer.petBase
  failCount = 0
  bootLog('加载本地页面: ' + petURL())
  win.loadURL(petURL())
}

/** 用 netstat 列出本机正在监听的端口（不靠固定端口去猜 —— 别人的端口可能完全不同） */
/** 端口 → 进程名（Windows：netstat -ano 给 PID，再用 tasklist 查名字；best effort） */
function scanPortOwners() {
  return new Promise((resolve) => {
    try {
      exec('netstat -ano -p tcp', { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve({})
        const portPid = {}
        for (const line of String(stdout).split('\n')) {
          if (!/LISTENING/i.test(line)) continue
          const m = line.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d{2,5})\s+\S+\s+LISTENING\s+(\d+)/i)
          if (m) portPid[Number(m[1])] = Number(m[2])
        }
        const pids = [...new Set(Object.values(portPid))].slice(0, 12)
        if (!pids.length) return resolve({})
        const names = {}
        let left = pids.length
        const done = () => {
          if (--left > 0) return
          const out = {}
          for (const [port, pid] of Object.entries(portPid)) out[port] = names[pid] || ''
          resolve(out)
        }
        for (const pid of pids) {
          exec('tasklist /FI "PID eq ' + pid + '" /NH /FO CSV', { timeout: 5000, windowsHide: true }, (e2, out2) => {
            if (!e2 && out2) {
              const mm = String(out2).match(/^"([^"]+)"/m)
              if (mm) names[pid] = mm[1]
            }
            done()
          })
        }
      })
    } catch (e) {
      resolve({})
    }
  })
}

function scanListeningPorts() {
  return new Promise((resolve) => {
    try {
      exec('netstat -ano -p tcp', { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve([])
        const ports = []
        for (const line of String(stdout).split('\n')) {
          if (!/LISTENING/i.test(line)) continue
          const m = line.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d{2,5})/)
          if (m) {
            const n = Number(m[1])
            if (n > 1023 && n < 65536) ports.push(n)
          }
        }
        // 去重 + 常见开发端口排前面（纯优化顺序，不影响正确性）
        const uniq = [...new Set(ports)]
        uniq.sort((a, b) => (a === 19387 || a === 3080 ? -1 : 0) - (b === 19387 || b === 3080 ? -1 : 0))
        resolve(uniq.slice(0, 60))
      })
    } catch (e) {
      resolve([])
    }
  })
}

function readPos() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'pos.json'), 'utf8'))
    if (Array.isArray(j) && j.length === 2 && Number.isFinite(j[0])) return j
  } catch (e) {}
  return null
}

/** 把窗口夹进「所有显示器工作区的并集」，越界就返回修正后的坐标 */
function clampToDisplays(x, y) {
  try {
    const areas = screen.getAllDisplays().map((d) => d.workArea)
    const w = 200, h = 120 // 只保证还有一块可见区域，允许半出屏（窗子本身很大）
    const inside = areas.some((a) => x + w > a.x && x < a.x + a.width && y + h > a.y && y < a.y + a.height)
    if (inside) return [x, y]
    const p = screen.getPrimaryDisplay().workArea
    return [p.x + p.width - 560, p.y + p.height - 300]
  } catch (e) {
    return [x, y]
  }
}

function savePos() {
  if (!win || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  const dir = app.getPath('userData')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'pos.json'), JSON.stringify([x, y]))
  } catch (e) {}
}

/** DSH 没起来 / 插件没装时给一张能看懂、能求助的页面 */
function showHint(installed) {
  if (!win || win.isDestroyed()) return
  const token = readToken()
  const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent}
  body{display:flex;align-items:center;justify-content:center;font:13px/1.7 "Microsoft YaHei",-apple-system,sans-serif;color:#fff;text-align:center}
  .box{background:rgba(18,22,34,.9);border:1px solid rgba(255,255,255,.18);border-radius:14px;padding:18px 22px;max-width:80%}
  .t{font-weight:600;margin-bottom:8px;font-size:15px}
  .s{opacity:.75;font-size:12px;margin-bottom:12px}
  button{font:inherit;padding:8px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.25);
    background:rgba(59,98,246,.9);color:#fff;cursor:pointer;margin:0 4px}
  code{background:rgba(127,150,255,.18);padding:2px 6px;border-radius:6px}
  </style><body><div class="box">
  <div class="t">🐋 正在找 DSH…</div>
  <div class="s">${token ? '通行证已就位，但连不上 <code>${petBase}</code>。<br>请确认 ① 装了插件 ② DSH 正在运行。' : '还没读到通行证 <code>~/.dsh/dsh-live2d-pet-desktop.json</code>。<br>请先在 DSH 里装插件，然后重启 DSH。'}</div>
  <button onclick="window.dshpet.install()">一键安装插件</button>
  <button onclick="window.dshpet.reload()">重新连接</button>
  </div>
  <script>
    window.dshpet = {
      install: () => window.dshpetBridge && window.dshpetBridge.install(),
      reload: () => window.dshpetBridge && window.dshpetBridge.reload(),
    }
  </script></body>`
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

/** 联动：替用户跑一遍插件安装命令（这就是「下载软件同时把插件装好」） */
function installPlugin() {
  const cmd = `dsh plugin --profile web add ${PLUGIN}`
  if (!win || win.isDestroyed()) return
  win.webContents
    .executeJavaScript(
      `document.querySelector('.s').innerHTML = '正在安装插件…<br><code>${cmd}</code>'`,
    )
    .catch(() => {})
  exec(cmd, { timeout: 300000, windowsHide: true }, (err, stdout, stderr) => {
    const tail = (err ? String(stderr || err.message) : String(stdout || '')).slice(-400)
    const ok = !err
    const msg = ok
      ? '✅ 插件装好了。<br>现在**重启一次 DSH**，然后点「重新连接」。<br><code>' + cmd + '</code>'
      : '❌ 没装成，可能要手动来一次：<br><code>' + cmd + '</code><br>错误：' + tail
    win.webContents
      .executeJavaScript(`document.querySelector('.s').innerHTML = ${JSON.stringify(msg)}`)
      .catch(() => {})
    if (ok) setTimeout(load, 4000)
  })
}

// ——————————————————————————————————————————————————————————————
// 贴边小球（收起态）
// ——————————————————————————————————————————————————————————————
function ballHTML() {
  const icon = readWhaleSVG()
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;-webkit-app-region:no-drag}
  .ball{width:100%;height:100%;border-radius:50%;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(120% 120% at 50% 0%, rgba(60,70,96,.98), rgba(16,20,32,.98));
    border:1.5px solid rgba(255,255,255,.34);box-shadow:0 6px 18px rgba(0,0,0,.38);cursor:pointer}
  .ball:hover{border-color:rgba(255,255,255,.6);transform:scale(1.06)}
  svg{width:58%;height:58%}
  svg path{fill:#fff}
  </style><body><div class="ball">${icon}</div></body>`
}

function readWhaleSVG() {
  const cands = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg',
  ]
  for (const p of cands) {
    try {
      const s = fs.readFileSync(p, 'utf8')
      if (s.includes('<svg')) return s.replace(/<style>[\s\S]*?<\/style>/, '')
    } catch (e) {}
  }
  return '<svg viewBox="0 0 24 24"><path d="M3 15c3 0 4-2 6-2s3 2 6 2 4-3 6-3v3c-2 0-3 3-6 3s-3-2-6-2-3 2-6 2z"/></svg>'
}

function createBall() {
  ballWin = new BrowserWindow({
    width: BALL,
    height: BALL,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    // ⚠️ 小球也必须挂 preload：它是靠 window.dshpetBridge 把点击/拖动报回来的，
    // 不挂就等于「小球点不动、拖不了」（写完先自查发现的）
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  })
  ballWin.setAlwaysOnTop(true, 'screen-saver')
  ballWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(ballHTML()))
  ballWin.webContents.on('did-finish-load', () => {
    // 点一下展开；拖一下挪位置（松手贴最近的一边）
    ballWin.webContents.executeJavaScript(`
      (function(){
        var d=false, moved=0, sx=0, sy=0;
        document.addEventListener('mousedown', function(e){ d=true; moved=0; sx=e.screenX; sy=e.screenY; e.preventDefault() });
        document.addEventListener('mousemove', function(e){ if(!d) return; moved=Math.max(moved, Math.abs(e.screenX-sx)+Math.abs(e.screenY-sy));
          if(moved>3) window.dshpetBridge && window.dshpetBridge.ballMove(e.screenX-sx, e.screenY-sy) });
        document.addEventListener('mouseup', function(){ if(!d) return; d=false;
          window.dshpetBridge && window.dshpetBridge.ballDrop(moved>3) });
      })()
    `).catch(() => {})
  })
  ipcMain.on('ball-move', (_e, dx, dy) => {
    if (!ballWin || !ballDrag) return
    ballWin.setPosition(Math.round(ballDrag[0] + dx), Math.round(ballDrag[1] + dy))
  })
  ipcMain.on('ball-drop', (_e, moved) => {
    if (!ballWin) return
    if (!moved) return expand()
    snapBall()
  })
}

function snapBall() {
  if (!ballWin) return
  const wa = screen.getPrimaryDisplay().workArea
  const [x, y] = ballWin.getPosition()
  const nearest = x + BALL / 2 < wa.x + wa.width / 2 ? wa.x + 4 : wa.x + wa.width - BALL - 4
  const ny = Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - BALL - 4)
  ballWin.setPosition(nearest, ny)
}

function collapse() {
  if (!win || collapsed) return
  collapsed = true
  savePos()
  const [wx, wy] = win.getPosition()
  const wa = screen.getPrimaryDisplay().workArea
  const onLeft = wx + WIN_W / 2 < wa.x + wa.width / 2
  if (!ballWin) createBall()
  ballWin.setPosition(onLeft ? wa.x + 4 : wa.x + wa.width - BALL - 4, Math.round(wy + WIN_H / 2 - BALL / 2))
  ballWin.showInactive()
  ballWin.setAlwaysOnTop(true, 'screen-saver')
  win.hide()
  ballDrag = [ballWin.getPosition()[0], ballWin.getPosition()[1]]
  setTimeout(snapBall, 30)
}

function expand() {
  if (!collapsed) return
  collapsed = false
  if (ballWin) {
    ballDrag = null
    ballWin.hide()
  }
  if (win) {
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.webContents.executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)').catch(() => {})
  }
}

// ——————————————————————————————————————————————————————————————
// 托盘菜单（Windows 上没有菜单栏图标，改放系统托盘）
// ——————————————————————————————————————————————————————————————
function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png')
  let img = nativeImage.createFromPath(iconPath)
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 })
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  tray.setToolTip('DS 鲸鱼娘桌宠')
  const rebuild = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '重新加载', click: load },
        { label: collapsed ? '展开桌宠' : '收起成小球（贴边）', click: () => (collapsed ? expand() : collapse()) },
        { label: '回到右下角', click: resetPos },
        { type: 'separator' },
        {
          label: '低性能模式（少动、省电）',
          type: 'checkbox',
          checked: lowPower,
          click: (mi) => {
            lowPower = mi.checked
            if (win) win.webContents.executeJavaScript('window.DSHPet && DSHPet.setLowPower && DSHPet.setLowPower(' + lowPower + ')').catch(() => {})
          },
        },
        { label: '一键安装插件（如果还没装）', click: installPlugin },
        { label: '打开 DSH 界面', click: () => shell.openExternal(petBase + '/') },
        { type: 'separator' },
        { label: '彻底退出', click: () => app.quit() },
      ]),
    )
  tray.on('click', () => (collapsed ? expand() : win && win.showInactive()))
  setInterval(rebuild, 1500)
  rebuild()
}

function resetPos() {
  if (!win) return
  const wa = screen.getPrimaryDisplay().workArea
  win.setPosition(wa.x + wa.width - WIN_W - 8, wa.y + wa.height - WIN_H - 8)
  savePos()
}

// ——————————————————————————————————————————————————————————————

// ————————————————————————————————————————————————————————————————
// 启动诊断（Issue #6 / #8 的血泪）：两位 Windows 用户都遇到「双击后无声无息」——
// 没有窗口、没有日志、没有 userData，连退出码都看不出来，完全没法定位。
// 所以这里做三件事：① 任何阶段都往文件写日志 ② 兜住未捕获异常/未处理 Promise
// ③ 启动失败时弹一个看得见的对话框，把日志路径告诉用户。
// ————————————————————————————————————————————————————————————————
const LOG_DIR = path.join(process.env.APPDATA || os.homedir(), 'ds-whale-girl-pet')
const LOG_FILE = path.join(LOG_DIR, 'boot.log')
function bootLog(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch (e) {}
  try {
    console.log('[dsh-pet]', msg)
  } catch (e) {}
}
bootLog(
  `=== 启动 v${require('./package.json').version} | electron ${process.versions.electron} | ` +
    `node ${process.versions.node} | exe=${process.execPath} | dir=${__dirname} | ` +
    `token=${fs.existsSync(TOKEN_FILE) ? '有' : '无'} ===`,
)
process.on('uncaughtException', (err) => {
  bootLog('未捕获异常: ' + (err && err.stack ? err.stack : String(err)))
})
process.on('unhandledRejection', (err) => {
  bootLog('未处理的 Promise 拒绝: ' + (err && err.stack ? err.stack : String(err)))
})

app.whenReady().then(async () => {
  try {
    bootLog('app ready')
    const srv = await startLocalServer()
    if (srv) { petBase = srv.petBase; bootLog('petBase=' + petBase) } else { bootLog('本地服务不可用：她只会渲染，媒体会话读不到') }
    app.setAppUserModelId('com.andersen216.dsh.whalegirlpet')
    createMain()
    bootLog('主窗口已创建')
    createTray()
    bootLog('托盘已创建')
    ipcMain.on('reload', load)
  } catch (err) {
    bootLog('启动失败: ' + (err && err.stack ? err.stack : String(err)))
    try {
      dialog.showErrorBox(
        'DS 鲸鱼娘桌宠 · 启动失败',
        '启动时出错了。日志文件在：\n' + LOG_FILE + '\n\n' +
          (err && err.message ? err.message : String(err)) +
          '\n\n把日志发到 GitHub issue 即可定位。',
      )
    } catch (e) {}
    app.exit(1)
  }
})
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  clearInterval(pollTimer)
  clearInterval(dragTimer)
})
