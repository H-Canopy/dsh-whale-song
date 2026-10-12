// 预加载脚本：给网页搭一座桥，让 Windows 版和 macOS 版**用同一套前端协议**。
//
// 关键点：前端 pet.js 里判断「我在不在桌面壳里」靠两个东西 ——
//   window.__DSHPET_SHELL__ 和 window.webkit.messageHandlers.dshpetshell.postMessage()
// 这俩是 macOS(WKWebView) 的原生接口。Electron 里没有，所以这里**照着原样补一个**，
// 于是前端一行都不用改，桌面壳里该有的行为（收起成小球、设置页多两项、打开 DSH）自动就有。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__DSHPET_SHELL__', true)
contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: {
    dshpetshell: {
      postMessage: (msg) => ipcRenderer.send('shell-msg', String(msg)),
    },
  },
})
// 提示页用的桥（DSH 没起来时那张卡片上的两个按钮）
contextBridge.exposeInMainWorld('dshpetBridge', {
  install: () => ipcRenderer.send('install-plugin'),
  reload: () => ipcRenderer.send('reload'),
})

// 拖动：页面里按下她 → 告诉主进程搬窗口（主进程只在鼠标确实压在她身上时才搬，
// 压在面板上时放行给网页，所以设置里的滑块照样能拖）
// 【诊断】把输入事件经 IPC 报给主进程（沙箱 preload 用不了 fs，所以不能自己写文件）。
//   用来判断"按下到底有没有到达窗口"—— 主进程侧看不到这一点。
//   本段由 make-standalone-shell.mjs 注入，改这里没用。
function dshwDiag(msg) {
  try { ipcRenderer.send('dshw-diag', String(msg)) } catch (e) {}
}
window.addEventListener('mousedown', function (e) { dshwDiag('mousedown btn=' + e.button + ' screen=' + e.screenX + ',' + e.screenY + ' client=' + e.clientX + ',' + e.clientY) }, true)
window.addEventListener('mouseup', function () { dshwDiag('mouseup') }, true)
dshwDiag('preload 已加载')

// ——— 拖动改「增量法」：页面算指针位移，主进程只做 setPosition ———
// 为什么换：老办法是主进程每 33ms 读全局光标再**反推**窗口位置（光标 − 抓手偏移）。
//   真机日志显示那样只有 x 跟得上、y 会冻住（cur 的 y 变了而 set 的 y 不动）。
//   增量法没有反推这一步，天生跟手，也不受 DPI 换算影响。
// 注册顺序很关键：这一组必须在文件末尾那两个老监听**之前**跑，
//   并在最后用同一件事把老监听「吃掉」，否则同一次按下会发两条 drag-start。
var dshwDown = null
var dshwLast = { x: 0, y: 0 }
var dshwN = 0
var dshwMovedMs = 0
window.addEventListener('mousedown', function (e) {
  if (e.button !== 0) return
  dshwDown = { x: e.screenX, y: e.screenY }
  dshwLast = { x: 0, y: 0 }
  dshwN = 0
  dshwMovedMs = Date.now()
  ipcRenderer.send('drag-start', { x: e.screenX, y: e.screenY, clientX: e.clientX, clientY: e.clientY })
}, true)
window.addEventListener('mousemove', function (e) {
  if (!dshwDown) return
  // 只发相对按下点的**累计**位移：帧丢了也不会漂（每帧都是绝对量，不是增量叠加）。
  var dx = e.screenX - dshwDown.x
  var dy = e.screenY - dshwDown.y
  if (dx === dshwLast.x && dy === dshwLast.y) return
  dshwLast = { x: dx, y: dy }
  dshwN++
  ipcRenderer.send('drag-move', { dx: dx, dy: dy })
}, true)
window.addEventListener('mouseup', function () {
  if (!dshwDown) return
  dshwDown = null
  // 【诊断】按下期间到底收到几次移动事件。区分两种"拖不动"：
  //   0 次 = 移动事件根本没进来（窗口没收到）；>0 次 = 事件的到了，问题在应用位移那一步。
  dshwDiag('拖放: 按下 ' + Math.round(dshwMovedMs || 0) + 'ms 内收到 ' + dshwN + ' 次移动')
  dshwN = 0
  dshwMovedMs = 0
  ipcRenderer.send('drag-end')
}, true)

// 老协议（无条件 drag-start / drag-end）在这里被同一个事件吃掉，
// 保证「要不要拖动」只由上面这组决定（真正的门禁在主进程：只有按在她本体上才搬窗口）。
function dshwSwallow(e) { if (e.type === "mouseup" || e.button === 0) e.stopImmediatePropagation() }
window.addEventListener('mousedown', dshwSwallow, true)
window.addEventListener('mouseup', dshwSwallow, true)
window.addEventListener('mousedown', (e) => {
  if (e.button === 0) ipcRenderer.send('drag-start', { x: e.screenX, y: e.screenY })
}, true)
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'), true)
