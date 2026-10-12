// 从上游壳 desktop/windows/main.js 生成独立壳 desktop/standalone/main.mjs。
// 只做"机械改动"，窗口行为（透明/置顶/穿透/托盘/贴边球）一行不碰。
/**
 * 仓库根定位：这个脚本放在 tools/shell-gen/ 下，
 * 往上退两级就是仓库根。不写死绝对路径 —— 否则别人 clone 下来跑不了。
 *
 * 历史：这几个生成器原来只存在于作者机器的 D:\Bigfish\_staging\（**不在仓库里**），
 * 而 main.js / preload.js / *.cjs 都是它们生成的产物 —— 于是 clone 下来的人
 * 拿到的是一堆"改了会被覆盖、却找不到生成器"的生成物。所以搬进仓库。
 */
const REPO = (() => {
  const cand = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const marker = path.join(cand, 'desktop', 'standalone')
  if (!fs.existsSync(marker)) {
    throw new Error('找不到仓库根：期望 ' + marker + ' 存在（脚本应放在 tools/shell-gen/ 下）')
  }
  return cand
})()
import { fileURLToPath } from 'node:url'

import fs from 'node:fs'
import path from 'node:path'

const SRC = path.join(REPO, 'desktop', 'windows', 'main.js')
const OUT_DIR = path.join(REPO, 'desktop', 'standalone')
fs.mkdirSync(OUT_DIR, { recursive: true })
let s = fs.readFileSync(SRC, 'utf8')

const must = (cond, msg) => { if (!cond) throw new Error('打补丁失败：' + msg) }

// ① 输出仍是 CommonJS —— **别改成 ESM**：Electron 33 的 ESM 加载器处理内置模块 electron 时会崩
//    （cjsPreparseModuleExports: Cannot read properties of undefined）。实测踩过。
s = s.replace(
  "const { app, BrowserWindow, Tray, Menu, screen, shell, session, ipcMain, nativeImage, dialog } =\n  require('electron')",
  "const { app, BrowserWindow, Tray, Menu, screen, shell, session, ipcMain, nativeImage, dialog } =\n  require('electron')",
)

// ③ 起本地服务（替代"找 DSH 宿主"）
must(s.includes("async function load() {"), '找不到 load()')
s = s.replace(
  "async function load() {",
  `// —— 独立模式改动 ①：本地迷你服务（静态资源 + SMTC），壳不再依赖 DSH ——
let petServer = null
async function startLocalServer() {
  if (petServer) return petServer
  try {
    const mod = require('./server.cjs')
    petServer = await mod.startPetServer({ extra: process.resourcesPath ? path.join(process.resourcesPath, 'dsh-whale-song') : '' })
    bootLog('本地服务已起: ' + petServer.url + ' (root=' + petServer.repoRoot + ')')
    return petServer
  } catch (err) {
    bootLog('本地服务启动失败: ' + (err && err.stack ? err.stack : String(err)))
    return null
  }
}

async function load() {`,
)

// ④ 不再需要 DSH 通行证（我们自己的服务没有信任栅栏）
must(s.includes('async function setTokenCookie()'), '找不到 setTokenCookie')
const tokenStart = s.indexOf('/** 读取 ~/.dsh 里的通行证')
const tokenEnd = s.indexOf('const hitJS =')
if (tokenStart > 0 && tokenEnd > tokenStart) {
  s = s.slice(0, tokenStart) + `// —— 独立模式改动 ②：不需要 DSH 通行证 ——
// 上游壳要读 ~/.dsh/dsh-live2d-pet-desktop.json 里那张票，是因为 DSH 插件的 /dsh-pet/* 有
// 信任栅栏。独立壳的静态资源与媒体接口都由**壳自己**提供（只监听 127.0.0.1），没有栅栏，
// 所以这里直接返回空/成功，让后面的流程照常往下走。
function readToken() { return '' }
async function setTokenCookie() { return true }

` + s.slice(tokenEnd)
}

// ④c 【抓她本体】给"按在她身上"加一层**容差**。
//   真机教训：掩码只覆盖画布约 78%×79%（它是有边距的角色剪影），于是她裙摆、脚这些
//   "掩码没盖到"的地方一按就被判成空气 → 主人觉得"点她身上拖不动"。
//   修法：单点判定之外，再按由近到远试若干点（只在为真时才承认）。
//   容差只用在**抓取**上，掩码本身一个像素都不改。
//   ⚠️ 这段必须做**整段替换**：上游那个 hitJS 是单行模板字符串，
//      用正则去找它的结尾很容易把后面的注释一起吃掉。
{
  const A = 'const hitJS ='
  const i = s.indexOf(A)
  if (i < 0) throw new Error('找不到 hitJS（容差注入点）')
  // 模板字符串以 "})()`" + 换行 结束
  const END = '}})()`'
  const e = s.indexOf(END, i)
  if (e < 0) throw new Error('找不到 hitJS 模板字符串结尾')
  const end = e + END.length
  const block = [
    '// 命中"放大倍数"：掩码只覆盖画布约 78%×79%（有边距的角色剪影），',
    '// 于是她裙摆/头/脚这些掩码没盖到的地方，一按就被判成空气 → 主人觉得"点她身上拖不动"。',
    '// 做法：把测试点朝她**掩码的中心收缩**，等价于把掩码**按比例放大** ——',
    '// 不是往外试固定半径（那样在她较窄的高度上补不到左侧，实测无效）。',
    'const PET_GRAB_ZOOM = 1.7',
    '',
    'const hitJS = (x, y) => `(function(){try{',
    "  var el=document.elementFromPoint(${x},${y});",
    "  var ui=!!(el&&el.closest&&el.closest('.dshp-panel,.dshp-menu,.dshp-hud,.dshp-bubble,.dshp-composer,.dshp-dock,.dshp-tab,.dshp-mail'));",
    "  if(ui) return 'panel';",
    "  if(!(window.DSHPet&&DSHPet.hitTest)) return 'none';",
    '  // 先试正点：最准，也不改变"点在透明空气上"这个原判定',
    "  if(DSHPet.hitTest(${x},${y})) return 'model';",
    '  // 再按 1/4、2/4、3/4、4/4 的力度朝掩码中心收缩（等价于掩码放大到 ZOOM 倍）',
    '  var st=document.querySelector(".dshp-stage");',
    '  var r=st?st.getBoundingClientRect():null;',
    '  var info=window.DSHPet.maskInfo?DSHPet.maskInfo():null;',
    '  var t=info&&info.tight?info.tight:null;',
    '  if(!r||!t||t.w<=0||t.h<=0) return \'none\';',
    '  var cx=t.x+t.w/2, cy=t.y+t.h/2;',
    '  var Z=${PET_GRAB_ZOOM};',
    '  for(var step=1;step<=4;step++){',
    '    var s=Z*step/4;',
    '    var px=Math.round(cx+(${x}-cx)/s), py=Math.round(cy+(${y}-cy)/s);',
    "    if(DSHPet.hitTest(px,py)) return 'model';",
    '  }',
    "  return 'none';",
    "}catch(e){return 'none'}})()`",
  ].join('\n')
  s = s.slice(0, i) + block + s.slice(end)
}
must(/PET_GRAB_ZOOM = 1\.7/.test(s), '抓取放大倍数没插进去')
must(/for\(var step=1;step<=4;step\+\+\)/.test(s), '抓取放大逐级试探没插进去')
must((s.match(/const hitJS =/g) || []).length === 1, 'hitJS 定义重复了')

// ④b load() 里那段"发现宿主"在独立壳里**必须去掉**：
//     它会扫本机端口，找到**正在跑的 DSH**（用户机器上通常就有 19387）就切过去 ——
//     于是独立壳又变回"DSH 的窗口"，本地服务白起了。实测踩过。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const lines = s.split(/\r?\n/)
  const at = lines.findIndex((l) => /^async function load\(\) \{/.test(l))
  if (at < 0) throw new Error('找不到 load()')
  // 找到 load() 的函数体范围（下一个顶层 function/结尾）
  let end = at + 1
  while (end < lines.length && !/^\}/.test(lines[end])) end++
  const body = [
    'async function load() {',
    '  if (!win || win.isDestroyed()) return',
    '  // —— 独立模式改动 ②b：**永远用我们自己起的本地服务** ——',
    '  // 上游这里会 setTokenCookie() + discoverHost()，扫本机端口找正在跑的 DSH 并切过去。',
    '  // 独立壳不需要 DSH；而且用户机器上通常**就有** DSH 在跑，那样会被"抢走"（实测踩过）。',
    '  if (!petServer || !petServer.petBase) {',
    '    const srv = await startLocalServer()',
    '    if (!srv) { failCount++; if (failCount >= 1) showHint(); setTimeout(load, 5000); return }',
    '  }',
    '  petBase = petServer.petBase',
    '  failCount = 0',
    '  bootLog(\'加载本地页面: \' + petURL())',
    '  win.loadURL(petURL())',
    '}',
  ]
  lines.splice(at, end - at + 1, ...body)
  s = lines.join(nl)
}
must(/永远用我们自己起的本地服务/.test(s), 'load() 没改掉（还在发现 DSH）')
must(!/const base = token \? await discoverHost\(token\) : null/.test(s), 'load() 里还留着 discoverHost 调用')

// ⑤ 目标地址：本地服务 + 壳专用页面
must(s.includes("const petURL = () => petBase + '/dsh-pet/standalone'"), '找不到 petURL')
s = s.replace(
  "const petURL = () => petBase + '/dsh-pet/standalone'",
  "// 壳专用页面（她本体，带壳能力的完整版）；浏览器里那个 standalone/ 是给外人看的 demo 页\nconst petURL = () => petBase + '/dsh-pet/app'",
)

// ⑥ 启动顺序：先起服务，再创建窗口（窗口创建里会 load()）
//    ⚠️ 上游文件是 **CRLF**：用 '\n' 拼的模板匹配不到，会**静默不替换**（踩过）。
//    所以这里用"找锚点行 + 按文件自己的行尾插入"，并在末尾断言真的插进去了。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const lines = s.split(/\r?\n/)
  const at = lines.findIndex((l) => /^app\.whenReady\(\)\.then\(\(\) => \{/.test(l))
  if (at < 0) throw new Error('找不到 whenReady 行')
  // 把 `app.whenReady().then(() => {` 改成 async，并在 try 之后插入启动服务
  lines[at] = lines[at].replace('.then(() => {', '.then(async () => {')
  const tryAt = lines.findIndex((l, i) => i > at && /^\s*try \{$/.test(l))
  if (tryAt < 0) throw new Error('找不到 whenReady 里的 try')
  const bootAt = lines.findIndex((l, i) => i > tryAt && /bootLog\('app ready'\)/.test(l))
  if (bootAt < 0) throw new Error('找不到 bootLog(\'app ready\')')
  lines.splice(bootAt + 1, 0,
    "    const srv = await startLocalServer()",
    "    if (srv) { petBase = srv.petBase; bootLog('petBase=' + petBase) } else { bootLog('本地服务不可用：她只会渲染，媒体会话读不到') }",
  )
  s = lines.join(nl)
}
must(/await startLocalServer\(\)/.test(s), '启动服务那两行没插进去')
must(/\.then\(async \(\) => \{/.test(s), 'whenReady 没改成 async')

// ⑦ 「打开 DSH」：连不上就说人话，别打开一个错误页
must(s.includes("case 'open-dsh':"), '找不到 open-dsh')
s = s.replace(
  "      case 'open-dsh':\n        shell.openExternal(petBase + '/')",
  `      case 'open-dsh': {
        // 独立模式改动 ③：DSH 可能根本没装/没开。用循环里那个发现逻辑探一下，
        // 探到才打开；探不到就告诉她"完整版要装 DSH"，并给出仓库地址。
        const base = await discoverDshHost()
        if (base) shell.openExternal(base + '/')
        else {
          try {
            dialog.showMessageBox({
              type: 'info',
              title: '搭配 DeepSeek Harness 才是完整版',
              message: '没检测到正在运行的 DeepSeek Harness（DSH）。',
              detail: '这个桌宠现在跑的是独立模式：能渲染、能换表情动作、能跟着系统音乐动。\\n' +
                '想让她跟着 agent 干活、看工作简报、用钱包、点歌，需要装着 DSH 的插件版：\\n\\n' +
                'dsh plugin --profile web add github:H-Canopy/dsh-whale-song\\n\\n' +
                '仓库：https://github.com/H-Canopy/dsh-whale-song',
              buttons: ['知道了', '打开仓库'],
              defaultId: 0,
            }).then((r) => { if (r && r.response === 1) shell.openExternal('https://github.com/H-Canopy/dsh-whale-song') }).catch(() => {})
          } catch (err) {}
        }
        break
      }`,
)

// ⑧ 加一个"只找 DSH"的探测函数（复用上游那套扫端口逻辑，供 open-dsh 用）
must(s.includes('async function discoverHost(token) {'), '找不到 discoverHost')
s = s.replace(
  'async function discoverHost(token) {',
  `/**
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

async function discoverHost(token) {`,
)

// ⑨ 窗口尺寸与拖动跟手（独立壳改动 ⑤⑥）
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const lines = s.split(/\r?\n/)
  const at = lines.findIndex((l) => /^const WIN_W = /.test(l))
  if (at < 0) throw new Error('找不到 WIN_W')
  lines[at] = 'const WIN_W = Number(process.env.DSHW_PET_W || 420) // 窗口只是"画布"：她只占右下角一块，其余是透明的'
  const at2 = lines.findIndex((l) => /^const WIN_H = /.test(l))
  if (at2 < 0) throw new Error('找不到 WIN_H')
  lines[at2] = 'const WIN_H = Number(process.env.DSHW_PET_H || 600) // 别比屏幕可视区还高（实测：900 高在可视 1019 的屏上，往上拖会被"夹回"挡住，像被关在框里）'
  s = lines.join(nl)
}
// ⑩ 拖动：push → follow（跟手）。上游是 `起点 + (指针 − 按下点)`，指针离按下点越远她越落后，
//    撞到夹取还会跳回来 → 用户实测"只能在按下点附近一小块里挪、还闪"。
must(s.includes('dragFrom = { mouse: at, win: win.getPosition() }'), '找不到拖动赋值（结构变了？）')
s = s.replace(
  'dragFrom = { mouse: at, win: win.getPosition() }',
  'dragFrom = { grab: await grabOffset(), n: 0, lastX: NaN, lastY: NaN, lastAt: 0, startedAt: Date.now(), w: win.getBounds().width, h: win.getBounds().height }',
)
must(s.includes('win.setPosition(dragFrom.win[0] + (p.x - dragFrom.mouse.x), dragFrom.win[1] + (p.y - dragFrom.mouse.y))'), '找不到拖动 setPosition')
s = s.replace(
  'win.setPosition(dragFrom.win[0] + (p.x - dragFrom.mouse.x), dragFrom.win[1] + (p.y - dragFrom.mouse.y))',
  [
    'const wantX = Math.round(p.x - dragFrom.grab.x)',
    '      const wantY = Math.round(p.y - dragFrom.grab.y)',
    '      // ⚠️ 性能（实测这台机器）：**透明窗口**的 setPosition 要 6.5ms（不透明只要 2.9ms）；',
    '      //   而原来这里是 16ms 一帧（60fps）→ 实测 60 帧拖了 1680ms（理想 960ms，超支 75%），',
    '      //   帧持续积压 = 用户看到的"晃 / 闪 / 轨迹不稳"。所以：',
    '      //   ① 位置没变就不调（省一半：3.1ms/次）；',
    '      //   ② 帧率降到 30fps（33ms）—— 60fps 在这台机器上根本供不起。',
    '      if (wantX === dragFrom.lastX && wantY === dragFrom.lastY) return',
    '      dragFrom.lastX = wantX',
    '      dragFrom.lastY = wantY',
    '      const t0 = Date.now()',
    '      win.setPosition(wantX, wantY)',
    '      const costMs = Date.now() - t0',
    '      // 拖动轨迹诊断（只记前 80 帧）：',
    '      //   want vs got 不一致 → 有东西把窗口挪回去了（夹取/系统限制）',
    '      //   cost 大 / gap 大    → 主进程供不起这个帧率（就是"晃/闪"的来源）',
    '      try {',
    '        if (dragFrom.n < 80) {',
    '          dragFrom.n++',
    '          const got = win.getPosition()',
    '          const now = Date.now()',
    '          const gap = dragFrom.lastAt ? now - dragFrom.lastAt : 0',
    '          dragFrom.lastAt = now',
    "          bootLog('drag: cur=' + p.x + ',' + p.y + ' want=' + wantX + ',' + wantY + ' got=' + got[0] + ',' + got[1] + ' cost=' + costMs + 'ms gap=' + gap + 'ms' + (got[0] !== wantX || got[1] !== wantY ? ' <-- 被挪走' : ''))",
    '        }',
    '      } catch (err) {}',
  ].join('\n      '),
)
must(/拖动轨迹诊断/.test(s), '拖动诊断没插进去')
// 帧率：60fps(16ms) → 30fps(33ms)。原因是实测：透明窗口 setPosition 要 6.5ms/次，
// 16ms 一帧必然积压（实测 60 帧跑了 1680ms），表现为"晃/闪/轨迹不稳"。
{
  const before = s
  s = s.replace("      }\n    }, 16)", "      }\n    }, 33)")
  if (s === before) {
    // 兜底：按行找（缩进可能不同）
    const nlT = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
    const L = s.split(/\r?\n/)
    const i = L.findIndex((l) => /^\s*\}, 16\)\s*$/.test(l))
    if (i < 0) throw new Error('找不到拖动的 16ms 定时器')
    L[i] = L[i].replace('16)', '33)')
    s = L.join(nlT)
  }
}
must(/}, 33\)/.test(s), '拖动帧率没降到 33ms')
// ⑯b 【再次修正】把 setInterval(33) 换成**自校正的 setTimeout**：
//   实测发现 Windows 的系统计时器粒度是 15.6ms，`setInterval(33)` 会被向上取整到
//   **46.8ms（3 个 tick）** —— 90 帧实测 4176~4196ms，与 90×46.8=4212 完全吻合。
//   也就是说"30fps"实际只有 ~21fps，这才是"闪/跳"的直接来源（而 setPosition 只要 1.8ms）。
//   自校正循环：以目标时间戳为准算下一次延时，这样能跨过粒度、长期不累积漂移。
//
// ⑯c 【外部评审抓到的严重 bug】改成自校正循环时，"位置没变就不调"写成了 `return`：
//   以前 setInterval 里 return 只是跳过一帧；现在 `setTimeout(tick)` 写在函数末尾，
//   这个 return 会让循环**再也不会被调度** → 只要有一帧指针没动（刚按下还没动、慢速微调、
//   中途停一下）拖动就**永久冻住**（表现正是"拖到一半卡住、像有空气墙"）。
//   修法：去重改成条件块，**调度永远放在块外**。
//   同时改用 `setBounds` 并固定按下时的宽高：150% 缩放下 `setPosition` 有把尺寸改 ±1px 的
//   已知毛病，尺寸一变画布就 resize → 视觉上就是闪。日志里也记宽高，有变化即坐实。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const L = s.split(/\r?\n/)
  const start = L.findIndex((l) => /dragTimer = setInterval\(\(\) => \{/.test(l))
  if (start < 0) throw new Error('找不到拖动定时器')
  let end = -1
  let depth = 0
  for (let i = start; i < L.length; i++) {
    depth += (L[i].match(/\{/g) || []).length - (L[i].match(/\}/g) || []).length
    if (depth === 0 && i > start) { end = i; break }
  }
  if (end < 0) throw new Error('拖动定时器括号不配平')
  const newBlock = [
    '      // —— 拖动 = **增量法**：页面按指针位移发 drag-move，这里只负责搬窗口 ——',
    '      // 老办法是"主进程每 33ms 读全局光标，再反推窗口位置（光标 − 抓手偏移）"。',
    '      // 真机日志证明那样只有 x 跟得上、y 会冻住（cur 的 y 从 318 变到 525，set 的 y 一直 114）。',
    '      // 现在位移由页面直接给出，主进程不做任何反推 → 天生跟手，也没有 DPI 换算的坑。',
    '      // 夹取/量化/写死宽高这三条老教训全部保留（见 dragMoveTo）。',
    '      const STEP_MS = 33',
    '      let movePending = false',
    '      const dragMoveTo = (dx, dy) => {',
    '        if (!dragFrom || !win || win.isDestroyed()) return',
    '        const c = clampPet(dragFrom.cx + dx, dragFrom.cy + dy, dragFrom.w, dragFrom.h)',
    '        const x2 = c.x - (c.x % 2), y2 = c.y - (c.y % 2)',
    '        // 基准点跟着「实际生效的位置」走：否则贴边时继续往外拖、夹取把它挡住不动，',
    '        // 而累计位移一直在涨 → 往回拖的瞬间会「弹」一下。',
    '        const appliedX = x2 - dragFrom.cx',
    '        const appliedY = y2 - dragFrom.cy',
    '        dragFrom.cx = x2',
    '        dragFrom.cy = y2',
    '        // 把夹取吃掉的那部分从待处理位移里扣掉',
    '        dragFrom.pendDx -= appliedX',
    '        dragFrom.pendDy -= appliedY',
    '        if (x2 === dragFrom.lx && y2 === dragFrom.ly) return',
    '        dragFrom.lx = x2',
    '        dragFrom.ly = y2',
    '        const t0 = Date.now()',
    '        win.setBounds({ x: x2, y: y2, width: dragFrom.w, height: dragFrom.h })',
    '        const costMs = Date.now() - t0',
    '        try {',
    '          if (dragFrom.n < 200) {',
    '            dragFrom.n++',
    '            const gb = win.getBounds()',
    '            const now = Date.now()',
    '            const gap = dragFrom.lastAt ? now - dragFrom.lastAt : 0',
    '            dragFrom.lastAt = now',
    "            bootLog('drag: d=' + dx + ',' + dy + ' set=' + x2 + ',' + y2 + ' got=' + gb.x + ',' + gb.y + ' size=' + gb.width + 'x' + gb.height + ' cost=' + costMs + 'ms gap=' + gap + 'ms' + (gb.x !== x2 || gb.y !== y2 ? ' <-- 被挪走' : '') + (gb.width !== dragFrom.w || gb.height !== dragFrom.h ? ' <-- 宽高变了(系统改的)' : ''))",
    '          }',
    '        } catch (err) {}',
    '      }',
    '      const runMove = () => {',
    '        movePending = false',
    '        if (!dragFrom) return',
    '        const t0 = Date.now()',
    '        dragMoveTo(dragFrom.pendDx, dragFrom.pendDy)',
    '        // 合并窗口内的多次 move → 每个 STEP_MS 只搬一次窗口（避免每毫秒 setBounds）',
    '        dragTimer = setTimeout(runMove, Math.max(0, STEP_MS - (Date.now() - t0)))',
    '      }',
    '      dragMove = (adx, ady) => {',
    '        if (!dragFrom) return',
    '        // 页面给的是**相对按下点的累计位移**，这里换算成「还要再挪多少」',
    '        dragFrom.pendDx = adx - dragFrom.cx',
    '        dragFrom.pendDy = ady - dragFrom.cy',
    '        if (movePending) return',
    '        movePending = true',
    '        dragTimer = setTimeout(runMove, 0)',
    '      }',
  ]
  L.splice(start, end - start + 1, ...newBlock)
  s = L.join(nl)
  if (process.env.SHELL_GEN_DEBUG) {
    console.log('[debug] 拖动循环替换: start=' + (start + 1) + ' end=' + (end + 1) + ' 新块行数=' + newBlock.length)
    const Lx = s.split(/\r?\n/)
    const ix = Lx.findIndex((l) => /const tick = /.test(l))
    for (let k = ix; k < ix + 6; k++) console.log('[debug]   ' + Lx[k])
  }
  // dragTimer 现在是 setTimeout 的句柄 → 清理必须用 clearTimeout（clearInterval 对它是无操作）
  {
    const L2 = s.split(/\r?\n/)
    for (let i = 0; i < L2.length; i++) L2[i] = L2[i].replace(/clearInterval\(dragTimer\)/g, 'clearTimeout(dragTimer)')
    s = L2.join(nl)
  }
}
must(/const STEP_MS = 33/.test(s) && /增量法/.test(s), '增量拖动没换上')
must(!/clearInterval\(dragTimer\)/.test(s), 'dragTimer 是 setTimeout 句柄，清理必须用 clearTimeout')
// ⚠️ 守门员：旧的"读全局光标反推位置"**必须彻底消失**。
//   真机日志证明那条路只有 x 跟得上、y 会冻住（cur 的 y 变了而 set 的 y 不动）。
must(!/getCursorScreenPoint\(\)[\s\S]{0,200}dragFrom\.grab/.test(s), '还在用"光标 − 抓手偏移"反推窗口位置')
must(!/dragFrom\.grab/.test(s), '抓手偏移（dragFrom.grab）应该已经彻底删除')
must(!/dragTimer = setTimeout\(tick/.test(s), '还在跑自校正 tick 循环')
// 拖动的三条老教训必须都还在：夹取、量化到偶数、写死按下时宽高
must(/const c = clampPet\(dragFrom\.cx \+ dx, dragFrom\.cy \+ dy, dragFrom\.w, dragFrom\.h\)/.test(s), '拖动没用 clampPet 夹取')
must(/const x2 = c\.x - \(c\.x % 2\), y2 = c\.y - \(c\.y % 2\)/.test(s), '拖动位置没量化到偶数')
must(/win\.setBounds\(\{ x: x2, y: y2, width: dragFrom\.w, height: dragFrom\.h \}\)/.test(s), '拖动没写死按下时的宽高')
must(/dragMove = \(adx, ady\) => \{/.test(s), 'drag-move 处理器没接上')
// 抓手偏移函数：增量法不需要它了，必须删干净（留着会误导下一轮）
{
  const at = s.indexOf('  async function grabOffset() {')
  if (at >= 0) {
    const L2 = s.split(/\r?\n/)
    const i = L2.findIndex((l) => /async function grabOffset\(\) \{/.test(l))
    let depth = 0
    let end = -1
    for (let k = i; k < L2.length; k++) {
      depth += (L2[k].match(/\{/g) || []).length - (L2[k].match(/\}/g) || []).length
      if (depth === 0 && k > i) { end = k; break }
    }
    if (end < 0) throw new Error('grabOffset 括号不配平')
    L2.splice(i, end - i + 1)
    s = L2.join(nl)
  }
  must(!/async function grabOffset/.test(s), 'grabOffset 没删干净')
}
// 拖动时必须固定宽高（写死按下时的值，防系统累积改动）
must(/size=' \+ gb\.width/.test(s), '拖动轨迹没记尺寸')
must(/必须夹进工作区|clampPet/.test(s), '屏幕夹取没保留')
// 拖动的进入/结束入口（drag-start 仍是异步的：要 await 页面里的命中判定）
must(s.includes("  ipcMain.on('drag-start', async (_e, at) => {"), '找不到 drag-start')
must(!/dragFrom\.win/.test(s), '还残留 push 语义的 dragFrom.win')

// ⑰ 拖动入口诊断：`drag-start` 到底有没有被触发、进来时窗口在哪、坐标是多少。
//    为什么必须记这个：主人拖了但 `drag:` 一条都没有 → 说明**拖动没被触发**。
//    而要区分"按下没到页面"和"到了但被守卫拦下"，只有入口这一行能说清。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const L = s.split(/\r?\n/)
  const at = L.findIndex((l) => /^  ipcMain\.on\('drag-start', async \(_e, at\) => \{/.test(l))
  if (at < 0) throw new Error('找不到 drag-start 处理器')
  L.splice(at + 1, 0,
    '    // 入口诊断：能到这一行，说明按下事件到了页面（否则是页面压根没收到按钮事件）',
    '    try {',
    '      const b0 = win && win.isDestroyed() ? null : win.getBounds()',
    "      bootLog('drag-start: at=' + JSON.stringify(at) + ' win=' + (b0 ? b0.x + ',' + b0.y + ' ' + b0.width + 'x' + b0.height : 'null') + ' visible=' + (win && win.isVisible()))",
    '    } catch (err) {}',
  )
  s = L.join(nl)
}
must(/drag-start: at=/.test(s), 'drag-start 入口诊断没插进去')

// ⑰b 拖动**结束**诊断：这次拖动持续多久、跑了几帧。
//   真机日志显示"按她脸"的那几下只有 ~105ms、只跑 1 帧（松手过快 → 看起来像没动），
//   而成功的那几次能连跑 20+ 帧。用它区分"用户只是点了一下"与"拖动被中途打断"。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const L = s.split(/\r?\n/)
  const at = L.findIndex((l) => /^\s*ipcMain\.on\('drag-end', \(\) => \{/.test(l))
  if (at < 0) throw new Error('找不到 drag-end 处理器')
  L.splice(at + 1, 0,
    '    // 拖动时长诊断（见上：用来区分「只是点了一下」和「拖动被打断」）',
    '    try {',
    '      if (dragFrom) {',
    '        const ms = Date.now() - (dragFrom.startedAt || Date.now())',
    "        bootLog('drag-end: 持续=' + ms + 'ms 帧数=' + (dragFrom.n || 0) + (ms < 150 ? '  <-- 松手过快(<150ms，看着就像没动)' : ''))",
    '      }',
    '    } catch (err) {}',
  )
  s = L.join(nl)
}
must(/drag-end: 持续=/.test(s), 'drag-end 时长诊断没插进去')

// ⑰e 【本次核心需求】拖动**只允许从她本体发起**。
//   主人的要求原话：「只能在本体区域，也就是形象的部分才可以拖动」。
//   判定用页面里的 DSHPet.hitTest（逐像素掩码，看的是她**真实画出来的轮廓**，不是包围盒）：
//     model   → 按在她身上        → 搬窗口（唯一允许拖动的情况）
//     panel   → 按在工具栏/气泡/菜单 → 让给网页（按钮、滑块、输入框照常工作）
//     none    → 按在透明空气里    → 什么都不做（窗口纹丝不动）
//   ⚠️ 以前这里只挡 panel，none 也照样搬窗口 —— 所以"抓透明区能拖、抓她形象反而没用"。
//   判定失败（页面还没加载完/异常）时**不拦**：宁可暂时能拖，也不要"完全拖不动"。
{
  const at = s.indexOf('      if (kind === \'panel\') return // 真控件（滑块/按钮/输入框）→ 让给网页')
  if (at < 0) throw new Error('找不到 drag-start 里的 panel 判定（本体门禁的插入点）')
  const guard = [
    '      // ★ 只有按在她**本体**上才拖：panel 让给网页，none（透明空气）直接不拖。',
    '      //   判定用页面里的 DSHPet.hitTest —— 逐像素看她真实画出来的轮廓。',
    '      //   ⚠️ 这行诊断必须在 return **之前**打，否则命中的是 none 时日志里什么都看不到，',
    '      //      只能靠猜（已经被这个坑绕了一轮）。',
    '      bootLog(\'drag-start: hit=\' + kind + \' local=\' + Math.round(at.x - b.x) + \',\' + Math.round(at.y - b.y))',
    '      if (kind !== \'model\') return',
  ].join('\n')
  s = s.slice(0, at) + guard + s.slice(at + '      if (kind === \'panel\') return // 真控件（滑块/按钮/输入框）→ 让给网页'.length)
}
must(/if \(kind !== 'model'\) return/.test(s), '本体门禁没插进去（拖动没限制在她身上）')
must(/drag-start: hit=' \+ kind/.test(s), 'hit 诊断没插进去（没有它就看不出为什么拖不动）')
must(!/if \(kind === 'panel'\) return/.test(s), '旧的 panel 判定还在（会让 none 也能拖）')


// ⑰f drag-start 的状态构造 + drag-move 接收端（增量法）
{
  const L = s.split(/\r?\n/)
  const at = L.findIndex((l) => /dragFrom = \{ grab:/.test(l))
  if (at < 0) throw new Error('找不到 dragFrom 构造（增量法改写点）')
  L[at] = "    dragFrom = { cx: win.getBounds().x, cy: win.getBounds().y, lx: NaN, ly: NaN, pendDx: 0, pendDy: 0, n: 0, lastAt: 0, startedAt: Date.now(), w: win.getBounds().width, h: win.getBounds().height }"
  s = L.join('\n')
}
must(/dragFrom = \{ cx: win\.getBounds\(\)\.x/.test(s), 'dragFrom 没换成增量法用的字段')
must(!/dragFrom = \{ grab:/.test(s), 'dragFrom 还是老结构')

// drag-move 接收端：接在 drag-start 处理器**末尾**（drag-end 之前）
{
  const L = s.split(/\r?\n/)
  const at = L.findIndex((l) => /^\s*ipcMain\.on\('drag-end', \(\) => \{/.test(l))
  if (at < 0) throw new Error('找不到 drag-end（drag-move 的插入点）')
  L.splice(at, 0,
    "  // 页面按指针位移发过来（preload 里记的是**相对按下点的累计位移**）。",
    "  // 这里只老老实实搬窗口，不做任何反推 —— 老办法就是死在反推上（y 冻住）。",
    "  ipcMain.on('drag-move', (_e, d) => {",
    '    if (typeof dragMove !== \'function\') return',
    '    if (!d) return',
    '    dragMove(Number(d.dx) || 0, Number(d.dy) || 0)',
    '  })',
  )
  s = L.join('\n')
}
must(/ipcMain\.on\('drag-move'/.test(s), 'drag-move 接收端没插进去')

// ⑳ 夹取抽成函数 + 按下时纠正一次 + 启动位置用它。
//   真机日志：窗口被抓到 y=-50 后，她在屏幕上被推到 y≈1044（超出工作区 1019）→ 她掉出屏幕，
//   用户看到的是"怎么拖都不动"。所以：
//   · 夹取的目标是"让她本体完整留在工作区内"（她画在窗口右下角，距右 10px、距下 49px）；
//   · 按下时立刻纠正一次，这样从出屏状态开始拖也能马上回到可见位置；
//   · 启动位置同样走这个函数（保证一开始她就是完整可见的）。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const L = s.split(/\r?\n/)
  // 1) 在 drag-start 处理器之前插入 clampPet（她本体必须在工作区内）
  const anchor = L.findIndex((l) => /^\s*ipcMain\.on\('drag-start', async \(_e, at\) => \{/.test(l))
  if (anchor < 0) throw new Error('找不到 drag-start（用来定位 clampPet 插入点）')
  L.splice(anchor, 0,
    '// 她画在窗口右下角：距右边 10px、距下边 49px、本体 240×209（见 _staging/measure-geo.mjs 实测）。',
    'const PET_BODY = { w: 240, h: 209, offR: 10, offB: 49 }',
    '/**',
    ' * 把窗口位置夹到"她本体完整留在工作区内"。',
    ' * 真机教训：不夹的话窗口会被拖到 y=-50，于是她在屏幕上被推到 y≈1044（超出工作区）→ 整个掉出屏幕，',
    ' * 表现就是"怎么拖都不动"。夹取的目标是**她本体**可见，而不是窗口本身。',
    ' */',
    'function clampPet(x, y, w, h) {',
    '  const wa = screen.getPrimaryDisplay().workArea',
    '  const PAD = 8',
    '  const minX = wa.x - (w - PET_BODY.offR - PET_BODY.w - PAD)',
    '  const maxX = wa.x + wa.width - PET_BODY.w - PET_BODY.offR - PAD',
    '  const minY = wa.y - (h - PET_BODY.offB - PET_BODY.h - PAD)',
    '  const maxY = wa.y + wa.height - PET_BODY.h - PET_BODY.offB - PAD',
    '  return { x: Math.max(minX, Math.min(maxX, x)), y: Math.max(minY, Math.min(maxY, y)) }',
    '}',
    '',
  )
  s = L.join(nl)
  // 2) （拖动循环里的内联夹取已在 ⑯c 生成 newBlock 时就写成 clampPet 调用了，这里不需再改）
  // 3) 按下时立刻纠正一次（从出屏状态开始拖也能救回）
  {
    const L3 = s.split(/\r?\n/)
    const at = L3.findIndex((l) => /dragFrom = \{ (grab: await grabOffset\(\)|cx: win\.getBounds\(\)\.x)/.test(l))
    if (at < 0) throw new Error('找不到 dragFrom 初始化')
    L3.splice(at + 1, 0,
      '    // 按下时先纠正一次位置：若她之前被拖到工作区外（真机出过：她在屏幕下方之外），',
      '    // 这一下就能把她拉回可见区域；否则拖动全程都在屏幕外，看起来就是"不动"。',
      '    try {',
      '      const cb = win.getBounds()',
      '      const cc = clampPet(cb.x, cb.y, cb.width, cb.height)',
      '      if (cc.x !== cb.x || cc.y !== cb.y) { const ex = cc.x - (cc.x % 2), ey = cc.y - (cc.y % 2); win.setBounds({ x: ex, y: ey, width: cb.width, height: cb.height }); bootLog("drag-start: 位置越界，已纠正 " + cb.x + "," + cb.y + " → " + ex + "," + ey) }',
      '    } catch (err) {}',
    )
    s = L3.join(nl)
  }
  // 4) 启动时的钉角位置也走 clampPet
  {
    const L4 = s.split(/\r?\n/)
    const at = L4.findIndex((l) => /^\s*win\.setPosition\(wa\./.test(l))
    if (at >= 0) {
      L4[at] = '  { const c0 = clampPet(wa.x + wa.width - WIN_W - OFFSET, wa.y + wa.height - WIN_H - OFFSET, WIN_W, WIN_H); win.setPosition(c0.x, c0.y) }'
    }
    s = L4.join(nl)
  }
}
must(/function clampPet\(x, y, w, h\)/.test(s), '夹取函数 clampPet 没插进去')
must(/const x2 = c\.x - \(c\.x % 2\), y2 = c\.y - \(c\.y % 2\)/.test(s), '拖动位置没有量化到偶数（实测这样才能不涨尺寸）')
must(/位置越界，已纠正/.test(s), '按下时的位置纠正没插进去')
// ⑰g 【修正】按下时若她越界会被拉回来，**拖动基准点必须同步** ——
//   否则那一帧 dragFrom.cx/cy 还是旧值，第一次 drag-move 会按旧基准算目标 → 她跳一下。
//   （必须在 ⑳ 把「位置越界」那行插进去**之后**才能改它。）
{
  const L = s.split(/\r?\n/)
  const i = L.findIndex((l) => /位置越界，已纠正/.test(l))
  if (i < 0) throw new Error('找不到「位置越界已纠正」那行（基准点同步点）')
  L.splice(i + 1, 0,
    '      if (dragFrom) { dragFrom.cx = ex; dragFrom.cy = ey; dragFrom.lx = ex; dragFrom.ly = ey }',
  )
  s = L.join('\n')
}
must(/dragFrom\.cx = ex; dragFrom\.cy = ey/.test(s), '纠正后没校准拖动基准')
// 夹取必须保证"她本体留在工作区内"（真机日志：窗口被拖到 y=-50 后她整只掉出屏幕）
must(/const minY = wa\.y - \(h - PET_BODY\.offB - PET_BODY\.h - PAD\)/.test(s) && /const maxY = wa\.y \+ wa\.height - PET_BODY\.h - PET_BODY\.offB - PAD/.test(s),
  'clampPet 的上下界没写对（要保证她本体留在工作区内）')

// ⑫ 拖动诊断：把 90ms 轮询的关键判定记进 boot.log（每 400ms 最多一行）
//    为什么常开：用户报"有时候抓不住她 / 拖动不稳"时，这是唯一的现场证据 ——
//    能直接看出那一瞬间 cursor / hit / ignore 三者是什么状态。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const lines = s.split(/\r?\n/)
  const at = lines.findIndex((l) => /^\s*setIgnore\(kind === 'none'\)\s*$/.test(l))
  if (at < 0) throw new Error('找不到 poll 里的 setIgnore(kind === none)')
  const diag = [
    '    // 拖动诊断：回答"为什么有时候抓不住她"。每 400ms 最多一行，很便宜。',
    '    const nowMs = Date.now()',
    '    if (nowMs - (globalThis.__dragDiagAt || 0) > 400) {',
    '      globalThis.__dragDiagAt = nowMs',
    "      bootLog('diag: cursor=' + p.x + ',' + p.y + ' local=' + Math.round(p.x - b.x) + ',' + Math.round(p.y - b.y) + ' hit=' + kind + ' ignore=' + (kind === 'none'))",
    '    }',
  ]
  lines.splice(at + 1, 0, ...diag)
  // 轮询启动时也记一行（确认它真的在跑）
  const t = lines.findIndex((l) => /pollTimer = setInterval\(poll, 90\)/.test(l))
  if (t < 0) throw new Error('找不到 pollTimer 启动')
  lines.splice(t + 1, 0, "  bootLog('拖动脉冲轮询已启动（90ms）')")
  s = lines.join(nl)
}
must(/diag: cursor=/.test(s) && /拖动脉冲轮询已启动/.test(s), '诊断注入没生效')

// ⑪ 窗口位置：**把窗口的右下角钉在屏幕右下角**（独立壳改动 ⑦）
//    为什么：她渲染在窗口的右下角，而窗口原来 560 宽 × 900 高。窗口一大，
//    `clampToDisplays` 就只允许它在很窄的范围里移动（900 高的窗口放在 1019 的可视区里，
//    上下只能动 ~119px）→ 用户实测"只能待在屏幕框附近"。改成钉右下角之后：
//    窗口左上角再往屏幕外多高都不影响她，而且窗口越小越好拖。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const lines = s.split(/\r?\n/)
  const at = lines.findIndex((l) => /if \(FULLSCREEN_PRIMARY\) \{/.test(l))
  if (at < 0) throw new Error('找不到 if (FULLSCREEN_PRIMARY) 定位块')
  // 用括号配平找整块结束（if 的 { ... } else { ... } 两块都要吃掉）
  let end = -1
  let depth = 0
  let lbCount = (lines[at].match(/\{/g) || []).length
  let rbCount = (lines[at].match(/\}/g) || []).length
  if (lbCount - rbCount <= 0) throw new Error('定位块首行括号不配平')
  let d = lbCount - rbCount
  end = at
  for (let i = at + 1; i < lines.length; i++) {
    d += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length
    end = i
    if (d === 0) break
  }
  if (end < 0 || d !== 0) throw new Error('定位块括号没配平')
  const anchor = [
    '    // —— 独立壳改动 ⑦：把窗口右下角钉在屏幕右下角 ——',
    '    // 她在窗口内是靠右下角渲染的，所以钉住右下角 = 把她固定在"离屏幕角 OFFSET 像素"处；',
    '    // 窗口左上角伸出屏幕多少都不影响她（那块本来就是透明的），而且窗口越小越好拖。',
    '    const OFFSET = 12',
    '    win.setPosition(wa.x + wa.width - WIN_W - OFFSET, wa.y + wa.height - WIN_H - OFFSET)',
    '',
    '  // ⚠️ 单位定案诊断（配合 D:\\Bigfish\\_staging\\probe-rgn-exact.ps1 用，定案后可以删）：',
    '  //    「窗口 422x602」到底是 CSS 还是物理像素，决定了成型区域的换算系数、也决定了方案 B 的尺寸预算。',
    '  //    getContentSize() 给 DIP/CSS，Win32 GetWindowRect 给物理像素：两者相等就是 1:1，',
    '  //    差 1.5 倍就必须做换算（不然区域会整体错位/缩放）。',
    '  win.webContents.once("did-finish-load", async () => {',
    '    try {',
    '      const b = win.getBounds()',
    '      const cs = win.getContentSize()',
    '      const d = screen.getPrimaryDisplay()',
    '      // 页面侧的 ground truth：innerWidth/innerHeight 是 **CSS**，devicePixelRatio 是缩放。',
    '      // 只有它跟 getContentSize 一比，才能分清"422x602"是 CSS 还是物理像素。',
    '      let page = "?"',
    '      try {',
    '        page = await win.webContents.executeJavaScript("JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio})")',
    '      } catch (err) { page = "EXC " + String(err && err.message) }',
    '      bootLog("单位定案: getBounds=" + b.width + "x" + b.height + " getContentSize=" + cs[0] + "x" + cs[1] + " workArea=" + d.workArea.width + "x" + d.workArea.height + " scaleFactor=" + d.scaleFactor + " page=" + page)',
    '    } catch (err) { bootLog("单位定案失败: " + String(err && err.message)) }',
    '  })',
  ]
  lines.splice(at, end - at + 1, ...anchor)
  s = lines.join(nl)
}
must(/把窗口右下角钉在屏幕右下角/.test(s), '定位改动没插进去')
must(!/const saved = readPos\(\)/.test(s), '还残留"恢复保存位置"的老逻辑')
// 断言必须在对应注入**之后**（本次注入就在上面那个 block 里）。先过滤注释行再匹配，
// 否则上面那两行注释里提到的 getContentSize 会把断言骗过去。
{
  const code = s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  must(/getContentSize\(\)/.test(code), '单位定案诊断没插进去')
  must(/单位定案: getBounds=/.test(code), '单位定案的日志行没插进去')
}

// ⑬ 窗口成型（Win32 区域）：把"鼠标在不在她身上"从**轮询猜**改成**窗口几何**
//    实测依据（_staging/demo-rgn-02/03）：裁成轮廓后，轮廓外点击由系统交给下面的窗口，
//    轮廓内点击稳定到达她 —— 于是那套 90ms 轮询 + setIgnoreMouseEvents 可以整段删掉，
//    而"有时候抓不住她"的根因（轮询空窗）也随之消失。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const lines = s.split(/\r?\n/)

  // ① 声明 petShaper（挨着 petServer）
  const vIdx = lines.findIndex((l) => /^let petServer = null$/.test(l))
  if (vIdx < 0) throw new Error('找不到 let petServer')
  lines.splice(vIdx + 1, 0, 'let petShaper = null')

  // ② 在 startLocalServer 里建成型器 + 用 onShape 接页面来的掩码
  const sIdx = lines.findIndex((l) => /^async function startLocalServer\(\) \{/.test(l))
  if (sIdx < 0) throw new Error('找不到 startLocalServer')
  lines.splice(sIdx + 1, 0,
    "  // 窗口成型器：页面会把命中掩码 POST 上来，据此把窗口裁成她的轮廓。",
    "  // getHwnd **每次现取**：窗口重建后句柄会变。",
    "  if (!petShaper) {",
    "    petShaper = createShaper({",
    "      getHwnd: () => {",
    "        try {",
    "          if (!win || win.isDestroyed()) return null",
    "          const buf = win.getNativeWindowHandle()",
    "          return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : Number(buf.readUInt32LE(0))",
    "        } catch (err) { return null }",
    "      },",
    "      // 轮廓向外**膨胀**的像素数（阴影/光晕/姿势漂移的余量）。",
    "      // 6→24：现在是真正的「轮廓膨胀」（原来是把矩形拉大，轮廓会被拉伸变形，本身也是偏移来源）。",
    "      expand: 24,",
    "      // 关键单位换算：页面给的是 **CSS/DIP**（getBounds/getContentSize/innerWidth 都是 422x602），",
    "      // 而 Win32 SetWindowRgn 收的是**物理像素**（同一窗口 GetWindowRect 实测 632x902 = ×1.5）。",
    "      // 所以区域必须 ×scaleFactor。⚠️ 这个换算只有在辅助进程声明 DPI 感知后才成立：",
    "      // 辅助进程以前是 DPI-unaware，系统会把它设的坐标再乘 1/1.5，正好把 ×1.5 抵消掉，",
    "      // 区域整体跑偏（表现为「只裁到她一部分」）—— 那才是老 bug 的真面目。",
    "      getScale: () => {",
    "        try {",
    "          const b = win.getBounds()",
    "          const d = screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) })",
    "          return (d && d.scaleFactor) || 1",
    "        } catch (err) { return 1 }",
    "      },",
    "      log: (m) => bootLog(m),",
    "    })",
    "  }",
    "  const shaper = petShaper",
  )
  const callIdx = lines.findIndex((l) => /mod\.startPetServer\(\{ extra:/.test(l))
  if (callIdx < 0) throw new Error('找不到 startPetServer 调用')
  // ⚠️ 默认**关闭**：区域与她的实际渲染位置还有约 100px 的偏差（见 README「窗口成型」一节），
  //    开着会把她裁掉一大半。等对齐了再把默认值改成开。开关走 settings.json（和上游的
  //    fullscreenPrimary 同一个文件、同一个读法）。不写这个文件 = 关闭 = 退回矩形窗口。
  lines[callIdx] = lines[callIdx].replace(
    'mod.startPetServer({ extra:',
    "mod.startPetServer({ onShape: (shape) => { if (readShapeWindow()) return shaper.submit(shape); return { ok: false, error: 'disabled' } }, extra:",
  )

  // ③ 保留/去掉轮询取决于机制：成型开着才去掉那套（否则整窗矩形会挡鼠标）
  //    这一段改成"按开关决定"，不再是无条件删除 —— 见 ⑭。
  s = lines.join(nl)
}
must(/createShaper\(\{/.test(s) && /onShape:\s*\(shape\)/.test(s), '成型器没接进 startLocalServer')
must(/readShapeWindow\(\)/.test(s), '成形开关没接到 onShape')
must(/createShaper/.test(s), '少了 createShaper 的 import')
if (!/window-shape\.cjs/.test(s)) {
  const nl3 = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const lines2 = s.split(/\r?\n/)
  // ⚠️ 必须插到**文件顶部**（和 electron / node:path 那一批 require 一起）：
  //    createShaper 是在 startLocalServer **外面**调用的，插在函数体里会 undefined（踩过）。
  const mIdx = lines2.findIndex((l) => /^const \{ app, BrowserWindow/.test(l))
  if (mIdx < 0) throw new Error('找不到顶部 require 区')
  lines2.splice(mIdx, 0, "const { createShaper } = require('./window-shape.cjs')")
  s = lines2.join(nl3)
}
must(/^const \{ createShaper \} = require\('\.\/window-shape\.cjs'\)/m.test(s), 'createShaper 的 require 没插到顶部')

// ⑭ 穿透机制：默认保留上游那套（整窗穿透 + 90ms 轮询），并说明与成型的互斥关系。
//    ⚠️ 必须保留！我第一版把 poll/setIgnore 一起删了，结果默认状态下留下一个
//    422×602 的矩形透明窗口**挡鼠标**（透明看不见，但鼠标到那儿就被它接走）——
//    主人当场发现"怎么还有鼠标跟随"，那是功能回退。
//    正确关系：成型**开** → 该关掉整窗穿透（轮廓之外本来就不算窗口）；
//             成型**关**（默认）→ 必须用上游那套。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const lines = s.split(/\r?\n/)
  const at = lines.findIndex((l) => /^\s*win\.setIgnoreMouseEvents\(true, \{ forward: true \}\)\s*$/.test(l))
  if (at < 0) throw new Error('找不到启动时的 setIgnoreMouseEvents(true)')
  lines.splice(at, 0,
    '  // —— 穿透机制：默认走上游那套（整窗穿透 + 90ms 轮询按需关掉）——',
    '  // 「窗口成型」（settings.json: shapeWindow=true）是另一条路：把窗口裁成她的轮廓，',
    '  // 轮廓之外根本不算窗口。两者**互斥**：成型开着时应改用下面这行注释掉的形式',
    '  // （否则连她身上也点不到）；成型关着时必须保留整窗穿透，否则矩形窗口会挡住鼠标。',
  )
  s = lines.join(nl)
}
// poll/setIgnore/pollTimer 必须还在（默认机制靠它们）
must(/^async function poll\(\) \{/m.test(s), 'poll() 丢了 —— 默认机制会失效（矩形窗口挡鼠标）')
must(/^function setIgnore\(on\) \{/m.test(s), 'setIgnore() 丢了')
must(/pollTimer = setInterval\(poll, 90\)/.test(s), 'poll 定时器丢了')

// ⑯ 【真 bug 修复】拖动期间**绝不切换** WS_EX_TRANSPARENT（Electron 的 setIgnoreMouseEvents）
//    原来 poll() 的判断顺序是：先看"指针在不在窗口矩形内"，再判 dragTimer。于是拖动中
//    （窗口在飞、getBounds 可能滞后一帧）指针会"看起来在窗口外" → 立刻 setIgnore(true) →
//    重新打开 WS_EX_TRANSPARENT → **窗口收不到按钮消息，拖动当场断**（表现：拖一半断、抖、像撞墙）。
//    这也是外部评审（豆包）清单里第 4/6 条讲的那个坑：拖动期间不能动穿透样式。
//    修法：把拖动守卫提到最前面，拖动期间 poll() 直接返回、什么都不改。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const L = s.split(/\r?\n/)
  const at = L.findIndex((l) => /^async function poll\(\) \{/.test(l))
  if (at < 0) throw new Error('找不到 poll()')
  const guardAt = L.findIndex((l, i) => i > at && /if \(dragTimer\) return/.test(l))
  if (guardAt < 0) throw new Error('找不到拖动守卫')
  L.splice(guardAt, 1)
  L.splice(at + 1, 0,
    '  // ⚠️ 拖动期间**一律不碰穿透样式**（WS_EX_TRANSPARENT / setIgnoreMouseEvents）：',
    '  //   拖动中窗口在飞，getBounds() 可能滞后一帧，指针会"看起来在窗口外"；',
    '  //   若这时切到穿透，窗口就收不到按钮消息 → 拖动当场断开（外部评审也点了这条）。',
    '  if (dragTimer) return',
  )
  s = L.join(nl)
}
must(/if \(dragTimer\) return/.test(s), '拖动守卫丢了')
// ⑮ 读 settings.json 里的 shapeWindow 开关（默认**关**）
//    userData 目录与上游的 fullscreenPrimary 共用同一个文件，写法一致：
//    %APPDATA%\DS-WhaleSong-Pet\settings.json → {"shapeWindow": true}
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const lines = s.split(/\r?\n/)
  const at = lines.findIndex((l) => /^function readFullscreenPrimary\(\) \{/.test(l))
  if (at < 0) throw new Error('找不到 readFullscreenPrimary（用它当锚点）')
  lines.splice(at, 0,
    '/**',
    ' * 是否启用「窗口成型」（把窗口裁成她的轮廓）。**默认关闭**：',
    ' * 目前区域与她的实际渲染位置还有偏差（实测约 100px，会把她裁掉一大半），见 README。',
    ' * 打开方式：%APPDATA%\\DS-WhaleSong-Pet\\settings.json 写 {"shapeWindow": true}。',
    ' */',
    'function readShapeWindow() {',
    '  try {',
    "    const p = path.join(app.getPath('userData'), 'settings.json')",
    '    return JSON.parse(fs.readFileSync(p, \'utf8\')).shapeWindow === true',
    '  } catch (err) { return false }',
    '}',
    '',
  )
  s = lines.join(nl)
}
must(/function readShapeWindow\(\)/.test(s), 'shapeWindow 开关没插进去')

// ㉑ settings.json 的 BOM 兜底。
//   真机踩到：用 PowerShell `Set-Content -Encoding utf8` 写的 settings.json 带 UTF-8 BOM
//   （EF BB BF），`JSON.parse` 直接抛错，被 catch 吞掉 → **开关静默失效**，日志里什么线索都没有。
//   而记事本等编辑器也可能写 BOM，所以解析前统一去掉。
//   （同理适用于 fullscreenPrimary —— 两个读函数共用这段兜底。）
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const L = s.split(/\r?\n/)
  const n = L.filter((l) => /JSON\.parse\(fs\.readFileSync\(p, 'utf8'\)\)/.test(l)).length
  if (n < 2) throw new Error('找不到 settings.json 的解析处（期望 2 处，实际 ' + n + '）')
  const n0 = L.filter((l) => /JSON\.parse\(fs\.readFileSync\(p, 'utf8'\)\)\./.test(l)).length
  if (n0 < 2) throw new Error('找不到 settings.json 的解析处（期望 2 处，实际 ' + n0 + '）')
  for (let i = 0; i < L.length; i++) {
    // ⚠️ 只匹配"右括号紧跟 JSON.parse 收尾"的那种（`.shapeWindow` / `.fullscreenPrimary`），
    //    不要碰 `JSON.parse(fs.readFileSync(p,'utf8')).hostPref` 这类（它们在别的函数里，也要 BOM 兜底，
    //    但本轮只针对 settings.json 的开关；放宽会把它们一起改掉，属于意外改动）。
    if (/JSON\.parse\(fs\.readFileSync\(p, 'utf8'\)\)\./.test(L[i])) {
      L[i] = L[i].replace("fs.readFileSync(p, 'utf8')", "stripBom(fs.readFileSync(p, 'utf8'))")
    }
  }
  // 在 readShapeWindow 之前插入 stripBom
  const at = L.findIndex((l) => /^function readShapeWindow\(\) \{/.test(l))
  if (at < 0) throw new Error('找不到 readShapeWindow（用来定位 stripBom 插入点）')
  L.splice(at, 0,
    '/**',
    ' * 去掉 UTF-8 BOM。真机踩到：用 PowerShell 写的 settings.json 带 EF BB BF，',
    ' * JSON.parse 直接抛错、又被 catch 吞掉 → 开关静默失效（表现得像"开关不生效"）。',
    ' * 记事本等编辑器也可能写 BOM，所以解析前统一兜底。',
    ' */',
    'function stripBom(t) { return String(t).replace(/^\\uFEFF/, \'\') }',
    '',
  )
  s = L.join(nl)
}
{
  // 3 处：settings.json 的两个开关读取（readShapeWindow / readFullscreenPrimary）
  //      + hostPref 读取（`JSON.parse(fs.readFileSync(p,'utf8')).hostPref`）。
  // 都该做 BOM 兜底（同一个坑：BOM → JSON.parse 抛错 → 被 catch 吞掉 → 静默失效）。
  const n = (s.match(/JSON\.parse\(stripBom\(fs\.readFileSync\(p, 'utf8'\)\)\)\./g) || []).length
  must(n === 3, 'BOM 兜底没换上（期望 3 处，实际 ' + n + '）')
  const raw = (s.match(/JSON\.parse\(fs\.readFileSync\(p, 'utf8'\)\)\./g) || []).length
  must(raw === 0, '还有没包 BOM 兜底的 JSON.parse（剩 ' + raw + ' 处）')
  const defs = (s.match(/function stripBom\(t\)/g) || []).length
  must(defs === 1, 'stripBom 定义数不对（期望 1，实际 ' + defs + '）')
}

// preload 原样复制（它只在页面里补 macOS 那套桥，和宿主无关）
fs.copyFileSync(path.join(REPO, 'desktop', 'windows', 'preload.js'), path.join(OUT_DIR, 'preload.js'))
console.log('复制 preload.js')
// ⚠️ 注意：main.js 的**唯一一次写盘在文件末尾**（第 71x 行附近）。所有对 s 的注入都必须在它之前，
//    否则注入只存在于内存、文件里没有（这个坑踩过两次：一次是 preload 诊断的接收端，一次是 ⑲）。

// ⑱ 给 preload 注入"输入到达"诊断（**在生成器里做**，别再直接改生成物 —— 会被这一步覆盖）
//    ⚠️ 关键发现：壳的 webPreferences 没关 sandbox，Electron 20+ **默认沙箱**，
//    沙箱里的 preload **不能用 require('node:fs')** —— 我第一版诊断就是因此静默失败的
//    （try/catch 吞掉）。所以诊断必须走 **IPC 回报**（ipcRenderer 在沙箱里可用）。
//    目的不变：把"按钮到底有没有到达窗口"钉死。
{
  const pre = path.join(OUT_DIR, 'preload.js')
  let p = fs.readFileSync(pre, 'utf8')
  if (!/dshwDiag/.test(p)) {
    const marker = "window.addEventListener('mousedown'"
    const at = p.indexOf(marker)
    if (at < 0) throw new Error('preload 里找不到 mousedown 监听')
    const diag = [
      '// 【诊断】把输入事件经 IPC 报给主进程（沙箱 preload 用不了 fs，所以不能自己写文件）。',
      '//   用来判断"按下到底有没有到达窗口"—— 主进程侧看不到这一点。',
      '//   本段由 make-standalone-shell.mjs 注入，改这里没用。',
      'function dshwDiag(msg) {',
      "  try { ipcRenderer.send('dshw-diag', String(msg)) } catch (e) {}",
      '}',
      "window.addEventListener('mousedown', function (e) { dshwDiag('mousedown btn=' + e.button + ' screen=' + e.screenX + ',' + e.screenY + ' client=' + e.clientX + ',' + e.clientY) }, true)",
      "window.addEventListener('mouseup', function () { dshwDiag('mouseup') }, true)",
      'dshwDiag(\'preload 已加载\')',
      '',
      '// ——— 拖动改「增量法」：页面算指针位移，主进程只做 setPosition ———',
      '// 为什么换：老办法是主进程每 33ms 读全局光标再**反推**窗口位置（光标 − 抓手偏移）。',
      '//   真机日志显示那样只有 x 跟得上、y 会冻住（cur 的 y 变了而 set 的 y 不动）。',
      '//   增量法没有反推这一步，天生跟手，也不受 DPI 换算影响。',
      '// 注册顺序很关键：这一组必须在文件末尾那两个老监听**之前**跑，',
      '//   并在最后用同一件事把老监听「吃掉」，否则同一次按下会发两条 drag-start。',
      'var dshwDown = null',
      'var dshwLast = { x: 0, y: 0 }',
      'var dshwN = 0',
      'var dshwMovedMs = 0',
      "window.addEventListener('mousedown', function (e) {",
      '  if (e.button !== 0) return',
      '  dshwDown = { x: e.screenX, y: e.screenY }',
      '  dshwLast = { x: 0, y: 0 }',
      '  dshwN = 0',
      '  dshwMovedMs = Date.now()',
      "  ipcRenderer.send('drag-start', { x: e.screenX, y: e.screenY, clientX: e.clientX, clientY: e.clientY })",
      '}, true)',
      "window.addEventListener('mousemove', function (e) {",
      '  if (!dshwDown) return',
      '  // 只发相对按下点的**累计**位移：帧丢了也不会漂（每帧都是绝对量，不是增量叠加）。',
      '  var dx = e.screenX - dshwDown.x',
      '  var dy = e.screenY - dshwDown.y',
      '  if (dx === dshwLast.x && dy === dshwLast.y) return',
      '  dshwLast = { x: dx, y: dy }',
      '  dshwN++',
      "  ipcRenderer.send('drag-move', { dx: dx, dy: dy })",
      '}, true)',
      "window.addEventListener('mouseup', function () {",
      '  if (!dshwDown) return',
      '  dshwDown = null',
      '  // 【诊断】按下期间到底收到几次移动事件。区分两种"拖不动"：',
      '  //   0 次 = 移动事件根本没进来（窗口没收到）；>0 次 = 事件的到了，问题在应用位移那一步。',
      "  dshwDiag('拖放: 按下 ' + Math.round(dshwMovedMs || 0) + 'ms 内收到 ' + dshwN + ' 次移动')",
      '  dshwN = 0',
      '  dshwMovedMs = 0',
      "  ipcRenderer.send('drag-end')",
      '}, true)',
      '',
      '// 老协议（无条件 drag-start / drag-end）在这里被同一个事件吃掉，',
      '// 保证「要不要拖动」只由上面这组决定（真正的门禁在主进程：只有按在她本体上才搬窗口）。',
      'function dshwSwallow(e) { if (e.type === "mouseup" || e.button === 0) e.stopImmediatePropagation() }',
      "window.addEventListener('mousedown', dshwSwallow, true)",
      "window.addEventListener('mouseup', dshwSwallow, true)",
      '',
    ].join('\n')
    p = p.slice(0, at) + diag + p.slice(at)
    fs.writeFileSync(pre, p, 'utf8')
    console.log('已给 preload 注入 IPC 输入诊断 + 增量拖动')
  }
}
// 主进程侧：收 preload 的诊断并写进 boot.log
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const L = s.split(/\r?\n/)
  const at = L.findIndex((l) => /ipcMain\.on\('drag-start'/.test(l))
  if (at < 0) throw new Error('找不到 drag-start（给诊断挂钩用）')
  L.splice(at, 0, "  ipcMain.on('dshw-diag', (_e, msg) => bootLog('preload: ' + msg))")
  s = L.join(nl)
}
// ⑰d 增量拖动：`dragMove(dx, dy)` 由 preload 的 drag-move 通道调用。
//   它必须先被声明（drag-start 里会给它赋值），否则那条赋值语句是隐式全局、严格模式下报错。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const L = s.split(/\r?\n/)
  const at = L.findIndex((l) => /^let dragFrom = null$/.test(l))
  if (at < 0) throw new Error('找不到 let dragFrom（给 dragMove 声明用）')
  L.splice(at + 1, 0, 'let dragMove = null')
  s = L.join(nl)
}
must(/^let dragMove = null$/m.test(s), 'dragMove 声明没插进去')
// ⑲ 【结构性修复】废掉"轮询切穿透"这套机制 —— 它是"闪"和"抓不住"的共同根因。
//
// 实测证据（真机日志）：
//   · `preload: mousedown` **0 条**，而 `preload: mouseup` 有 2 条 ——
//     说明按下被"穿透"吃掉了，抬起却进得来（Electron 的 forward:true 只转发移动，不转发按键）；
//   · `diag:` 里 `ignore` 在 true↔false 之间反复翻转，用户观感就是"指针一靠近她就闪"。
// 每次切 `setIgnoreMouseEvents` = 加/去 `WS_EX_TRANSPARENT` = **整窗重新合成** → 闪。
//
// 几何实测（壳窗口 422×602，CSS=窗口坐标）：
//   她本体 x 172–412 y 344–553；工具栏 y 560–587；菜单/面板/钱包 x 53–441 y 33–333。
//   → "有用区域"几乎等于整个窗口 ⇒ 让空白处穿透**几乎换不来什么**，却要付出闪 + 抓不住的代价。
//
// 所以：**窗口永远保持可交互**（不调 setIgnoreMouseEvents），删掉 90ms 轮询与 setIgnore。
// 精确判定仍由页面里的 `hitTest`（掩码）负责 —— 它本来就在做这件事，而且不涉及窗口样式切换。
// 若以后要把窗口压小 / 让空白真穿透，正确做法是"面板改向下弹 + SetWindowRgn 定型"，
// 而不是回到轮询。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const L = s.split(/\r?\n/)
  // 1) 删掉 poll() 整个函数
  const pIdx = L.findIndex((l) => /^async function poll\(\) \{/.test(l))
  if (pIdx < 0) throw new Error('找不到 poll()')
  let pEnd = pIdx
  let depth = 0
  for (let i = pIdx; i < L.length; i++) {
    depth += (L[i].match(/\{/g) || []).length - (L[i].match(/\}/g) || []).length
    pEnd = i
    if (depth === 0) break
  }
  L.splice(pIdx, pEnd - pIdx + 1,
    '// —— 已删除：90ms 的"鼠标在不在她身上"轮询 + setIgnoreMouseEvents 切换 ——',
    '// 真机日志证据：只有 mouseup 没有 mousedown（按下被穿透吃掉）；',
    '// 且 ignore 反复翻转导致整窗重新合成 = 用户看到的"闪"。窗口现在**永远可交互**，',
    '// 精确判定交给页面里的 hitTest（掩码），它不需要切窗口样式。',
  )
  // 2) 删掉 setIgnore 函数
  const igIdx = L.findIndex((l) => /^function setIgnore\(on\) \{/.test(l))
  if (igIdx >= 0) {
    let e = igIdx
    let d2 = 0
    for (let i = igIdx; i < L.length; i++) {
      d2 += (L[i].match(/\{/g) || []).length - (L[i].match(/\}/g) || []).length
      e = i
      if (d2 === 0) break
    }
    L.splice(igIdx, e - igIdx + 1)
  }
  // 3) 删掉启动时的整窗穿透
  const siIdx = L.findIndex((l) => /^\s*win\.setIgnoreMouseEvents\(true, \{ forward: true \}\)\s*$/.test(l))
  if (siIdx < 0) throw new Error('找不到启动时的 setIgnoreMouseEvents(true)')
  L.splice(siIdx, 1,
    '  // 不调 setIgnoreMouseEvents：窗口永远可交互（理由见上面 poll/setIgnore 被删处）。',
    '  // 代价：窗口左上角那块空白会挡住鼠标（不再是穿透）；面板/菜单本来就要用那片区域，',
    '  // 真要收回来，走"面板向下弹 + SetWindowRgn 定型"，不要再回到轮询。',
  )
  // 4) 删掉 poll 定时器启动
  const tIdx = L.findIndex((l) => /pollTimer = setInterval\(poll, 90\)/.test(l))
  if (tIdx >= 0) {
    let del = 1
    while (tIdx + del < L.length && !/^\s*$/.test(L[tIdx + del]) && /bootLog|setInterval|^\s*\}\)?\s*$/.test(L[tIdx + del])) del++
    L.splice(tIdx, del)
  }
  // 5) 清掉残留的 pollTimer（声明行 + 退出时的 clearInterval）—— 不留死变量
  for (let i = L.length - 1; i >= 0; i--) {
    if (/^\s*let pollTimer = null\s*$/.test(L[i]) || /clearInterval\(pollTimer\)/.test(L[i])) L.splice(i, 1)
  }
  s = L.join(nl)
  if (process.env.SHELL_GEN_DEBUG) {
    const c = s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    console.log('[debug] ⑲ 之后: setIgnoreMouseEvents=' + (c.match(/setIgnoreMouseEvents\s*\(/g) || []).length +
      ' pollTimer=' + (c.match(/pollTimer/g) || []).length +
      ' pollDef=' + (/async function poll/.test(c) ? '在' : '无'))
  }
}


// ㉓ 【主人拍板】**整个删掉「收起成小球」**。
//   真机现象：收成小球后小球被放到屏幕外（点不到、回不来），后来又变成一个巨大的深色圆盘
//   且**越变越大**。它带来的价值只有"折叠"这一项，而它已经两次让人失联，
//   所以整条线拆掉，不留"折叠态"这个状态 —— 桌宠永远在线，不再有回不来的可能。
//   托盘图标仍然保留（右键菜单里有重新加载 / 回到右下角 / 低性能 / 退出）。
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  let L = s.split(/\r?\n/)
  if (process.env.SHELL_GEN_DEBUG) {
    console.log('[debug] 小球删除前，含 ball/collapsed 的行：')
    L.forEach((l, k) => { if (/ball|collapsed|BALL/i.test(l)) console.log('  L' + (k + 1) + ': [' + l + ']') })
  }

  // 括号配平，删掉「从某行开始到配平结束」的整块
  const cutBlock = (re, label) => {
    const i = L.findIndex((l) => re.test(l))
    if (i < 0) throw new Error('找不到要删的函数：' + label)
    let d = 0
    let end = -1
    for (let k = i; k < L.length; k++) {
      d += (L[k].match(/\{/g) || []).length - (L[k].match(/\}/g) || []).length
      if (d === 0 && k > i) { end = k; break }
    }
    if (end < 0) throw new Error(label + ' 括号不配平')
    L.splice(i, end - i + 1)
  }
  const cutFn = (name) => cutBlock(new RegExp('^function ' + name + '\\('), name)

  // ① 小球窗口 + 折叠态：**按段落标记整段切掉**（从"贴边小球（收起态）"到"托盘菜单"之前）。
  //    ⚠️ 不能用花括号配平来切：ballHTML / createBall 里都有模板字面量 `${...}`，
  //       那个 `{` 会把计数器骗歪，导致切少了（实测 ball-move 处理器被漏掉）。
  //    段落标记是唯一的、且不随注入漂移，最稳。
  {
    const from = s.indexOf('// 贴边小球（收起态）')
    const to = s.indexOf('// 托盘菜单（Windows 上没有菜单栏图标，改放系统托盘）')
    if (from < 0) throw new Error('找不到「贴边小球（收起态）」段落标记')
    if (to < 0 || to <= from) throw new Error('找不到「托盘菜单」段落标记')
    // 连同前面的分隔线一起删（分隔线就是 from 上面那一行）
    const lineStart = s.lastIndexOf('\n', from)
    s = s.slice(0, lineStart < 0 ? from : lineStart + 1) + s.slice(to)
  }
  L = s.split(/\r?\n/)
  // ② （已并入 ①：ball-move / ball-drop 两个处理器就在 createBall 之后、snapBall 之前，
  //     整段切掉时一并删除了。这里不再单独处理 —— 单独处理反而会因为找不到而报错。）
  // ③ 声明行
  L = L.filter((l) => !/^const BALL = 62$/.test(l))
  L = L.filter((l) => !/^let ballWin = null$/.test(l))
  L = L.filter((l) => !/^let ballDrag = null$/.test(l))
  L = L.filter((l) => !/^let collapsed = false$/.test(l))
  // ④ 托盘菜单里那一项 + 托盘点击
  L = L.map((l) => /收起成小球/.test(l) ? null : l).filter((l) => l !== null)
  L = L.map((l) => /tray\.on\('click'/.test(l) ? "  tray.on('click', () => win && win.showInactive())" : l)
  // ⑤ 壳消息里的 collapse / expand —— 一律改成"永远显示"
  L = L.map((l) => /^(\s*)case 'collapse':$/.test(l) ? l.replace("case 'collapse':", "case 'collapse':  // 折叠已删：收到也当显示处理") : l)
  L = L.map((l) => /^\s*if \(!collapsed\) collapse\(\)\s*$/.test(l) ? '        showPetAlways()' : l)
  L = L.map((l) => /^\s*if \(collapsed\) expand\(\)\s*$/.test(l) ? '        showPetAlways()' : l)

  s = L.join(nl)

  // 兜底函数：她永远在线
  const at = s.indexOf('// ——————————————————————————————————————————————————————————————\n// 托盘菜单')
  const helper = [
    '/** 折叠功能已删除：任何"显示她"的请求都走这里。 */',
    'function showPetAlways() {',
    '  try {',
    '    if (!win || win.isDestroyed()) return',
    '    win.showInactive()',
    '    win.setAlwaysOnTop(true, \'screen-saver\')',
    '    win.webContents.executeJavaScript(\'window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)\').catch(() => {})',
    '  } catch (err) {}',
    '}',
    '',
  ].join('\n')
  if (at < 0) throw new Error('找不到托盘菜单注释（showPetAlways 插入点）')
  s = s.slice(0, at) + helper + s.slice(at)
}
// 小球相关的痕迹必须**一个不剩**
for (const [re, name] of [
  [/ballWin/, 'ballWin'],
  [/ballAnchor/, 'ballAnchor'],
  [/snapBall/, 'snapBall'],
  [/\bcreateBall\b/, 'createBall'],
  [/\bcollapse\(\)/, 'collapse()'],
  [/\bexpand\(\)/, 'expand()'],
  [/收起成小球/, '收起成小球的菜单项'],
  [/^const BALL = 62$/m, 'BALL 常量'],
  [/^\s*let collapsed = false$/m, 'collapsed 变量'],
]) {
  must(!re.test(s), '小球残留没删干净：' + name)
}
must(/function showPetAlways\(\)/.test(s), 'showPetAlways 没插进去')

// ㉓b preload 里那个只给小球用的桥（ballMove / ballDrop）也摘掉 ——
//    小球已经整条删除，留着这两个方法会让下一个人以为还有折叠态。
{
  const pre = path.join(OUT_DIR, 'preload.js')
  const p = fs.readFileSync(pre, 'utf8')
  const out = p.split(/\r?\n/).filter((l) => !/ballMove:|ballDrop:/.test(l)).join('\n')
  if (out !== p) {
    fs.writeFileSync(pre, out, 'utf8')
    console.log('已从 preload 摘掉小球用的 ballMove / ballDrop')
  }
}
must(!/ballMove|ballDrop/.test(fs.readFileSync(path.join(OUT_DIR, 'preload.js'), 'utf8')), 'preload 里还有小球桥的残留')

// ㉓c 【补回"收起"】小球删掉之后，主人**失去了把她藏起来的唯一办法**（真机反馈：
//    "现在的甚至不如没改前"）。小球之所以被删，是因为它自己会跑出屏幕 / 越变越大 / 回不来；
//    但"能把她收起来"这个**需求**是真的。所以用不依赖任何第二个窗口的方式补回来：
//      · 托盘菜单：「隐藏桌宠 / 显示桌宠」开关；
//      · 她工具栏那个 `−` 按钮：原本就是"收起"，现在让它在"显示/隐藏"之间切换；
//      · 隐藏后托盘图标的提示会变成"点我显示"，而且托盘 click 永远能把她叫回来
//        —— 这是**永远不会失联**的恢复路径（不像小球可能跑到屏幕外）。
{
  const at = s.indexOf('// ——————————————————————————————————————————————————————————————\n// 托盘菜单')
  const helper = [
    '/**',
    ' * 把她整体藏起来 / 叫回来。',
    ' * 为什么不是"收起成小球"：小球是第二个透明窗口，真机上出过"被放到屏幕外、点不到、回不来"',
    ' * 和"越变越大"两次事故，所以整条删掉了。但"能把她收起来"这个需求是真的，',
    ' * 这里用主窗口自己的 hide/show 实现 —— 托盘图标一直在，所以永远叫得回来。',
    ' */',
    'let petHidden = false',
    'function showPet() {',
    '  if (!win || win.isDestroyed()) return',
    '  petHidden = false',
    '  win.showInactive()',
    "  win.setAlwaysOnTop(true, 'screen-saver')",
    "  win.webContents.executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)').catch(() => {})",
    '  syncTrayMenu()',
    '  bootLog("桌宠: 已显示（托盘可再次隐藏）")',
    '}',
    'function hidePet() {',
    '  if (!win || win.isDestroyed()) return',
    '  petHidden = true',
    '  win.hide()',
    '  syncTrayMenu()',
    '  bootLog("桌宠: 已隐藏（托盘图标 → 显示桌宠 可以叫回来）")',
    '}',
    'function togglePet() { if (petHidden) showPet(); else hidePet() }',
    '',
  ].join('\n')
  if (at < 0) throw new Error('找不到托盘菜单注释（showPet/hidePet 插入点）')
  s = s.slice(0, at) + helper + s.slice(at)
}
must(/function showPet\(\)/.test(s) && /function hidePet\(\)/.test(s), 'showPet/hidePet 没插进去')

// ㉓d 托盘：把内联菜单模板换成 syncTrayMenuBody()，并去掉每 1.5s 的无脑重建。
//      （原来 `setInterval(rebuild, 1500)` 会一直覆盖菜单，隐藏/显示那一项也会被它刷回去）
{
  const L = s.split(/\r?\n/)
  const i = L.findIndex((l) => /^\s*const rebuild = \(\) =>/.test(l))
  if (i < 0) throw new Error('找不到托盘的 rebuild（syncTrayMenu 改写点）')
  // 删掉整个 const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([...])) 块
  let end = -1
  let d = 0
  for (let k = i; k < L.length; k++) {
    d += (L[k].match(/[([{]/g) || []).length - (L[k].match(/[)\]}]/g) || []).length
    if (d === 0 && k > i) { end = k; break }
  }
  if (end < 0) throw new Error('托盘 rebuild 块括号不配平')
  L.splice(i, end - i + 1)
  s = L.join('\n')
}
{
  const L = s.split(/\r?\n/)
  const i = L.findIndex((l) => /^\s*tray\.setToolTip\('DS 鲸鱼娘桌宠'\)\s*$/.test(l))
  if (i >= 0) L.splice(i, 1, '  // 说明文字与菜单项都由 syncTrayMenuBody() 负责（它会随隐藏/显示状态刷新）')
  const j = L.findIndex((l) => /^\s*setInterval\(rebuild, 1500\)\s*$/.test(l))
  if (j >= 0) L.splice(j, 1)
  const k = L.findIndex((l) => /^\s*rebuild\(\)\s*$/.test(l))
  if (k >= 0) L.splice(k, 1, '  syncTrayMenu()')
  // 托盘图标点击：隐藏时**必须把她叫回来**（这是永远不会失联的恢复路径）
  const t = L.findIndex((l) => /^\s*tray\.on\('click'/.test(l))
  if (t >= 0) L[t] = "  tray.on('click', () => { if (petHidden) showPet(); else if (win) win.showInactive() })"
  s = L.join('\n')
}
must(/^\s*syncTrayMenu\(\)\s*$/m.test(s), 'createTray 里没接上 syncTrayMenu()')
must(!/setInterval\(rebuild, 1500\)/.test(s), '托盘菜单还在每 1.5s 无脑重建（会把"隐藏/显示"刷回去）')
must(!/const rebuild = \(\) =>/.test(s), '旧的 rebuild 内联模板还在')

// ㉓e 她工具栏那个 `−` 按钮 = 显示/隐藏切换。
//     它原来的语义就是"收起成小球"；小球删了之后它变成空操作，白留一个死按钮。
{
  const L = s.split(/\r?\n/)
  const i = L.findIndex((l) => /case 'collapse':/.test(l))
  if (i < 0) throw new Error('找不到 case collapse（− 按钮接线点）')
  L[i] = "      case 'collapse':"
  L.splice(i + 1, 1, '        // `−` 按钮：原本是收起成小球，现在改成显示/隐藏她（小球已删）', '        togglePet()')
  s = L.join('\n')
}
must(/togglePet\(\)/.test(s), '− 按钮没接到 togglePet')

// 把 syncTrayMenu 定义（内含原菜单模板 + 隐藏项）插在 createTray 之前
{
  const at = s.indexOf('function createTray() {')
  if (at < 0) throw new Error('找不到 createTray（syncTrayMenu 插入点）')
  const header = s.lastIndexOf('// ——————————————————————————————————————————————————————————————', at)
  const where = header >= 0 ? header : at
  const fn = [
    '/**',
    ' * 托盘菜单的**唯一**构建处（显示状态变了要刷文字，所以抽成函数）。',
    ' * 原来这套模板内联在 createTray 里、还被 setInterval 每 1.5s 重建一次；',
    ' * 现在改成"状态变化时重建"，顺便把「隐藏/显示桌宠」加进来。',
    ' */',
    'function syncTrayMenuBody() {',
    '  if (!tray) return',
    "  tray.setToolTip(petHidden ? 'DS 鲸鱼娘桌宠（已隐藏，点我显示）' : 'DS 鲸鱼娘桌宠')",
    '  tray.setContextMenu(Menu.buildFromTemplate([',
    "    { label: petHidden ? '显示桌宠' : '隐藏桌宠', click: togglePet },",
    "    { label: '重新加载', click: load },",
    "    { label: '回到右下角', click: resetPos },",
    "    { type: 'separator' },",
    '    {',
    "      label: '低性能模式（少动、省电）',",
    "      type: 'checkbox',",
    '      checked: lowPower,',
    '      click: (mi) => {',
    '        lowPower = mi.checked',
    "        if (win) win.webContents.executeJavaScript('window.DSHPet && DSHPet.setLowPower && DSHPet.setLowPower(' + lowPower + ')').catch(() => {})",
    '        syncTrayMenu()',
    '      },',
    '    },',
    "    { label: '一键安装插件（如果还没装）', click: installPlugin },",
    "    { label: '打开 DSH 界面', click: () => shell.openExternal(petBase + '/') },",
    "    { type: 'separator' },",
    "    { label: '彻底退出', click: () => app.quit() },",
    '  ]))',
    '}',
    'function syncTrayMenu() {',
    '  if (!tray) return',
    '  try { syncTrayMenuBody() } catch (err) { bootLog("托盘菜单重建失败: " + String(err && err.message)) }',
    '}',
    '',
  ].join('\n')
  s = s.slice(0, where) + fn + s.slice(where)
}
must(/function syncTrayMenuBody\(\)/.test(s), 'syncTrayMenuBody 没插进去')

// ⑰h 【自检】她到底在窗口里的哪儿、命中掩码对不对。
//   为什么要它：主人说"点她形象拖不动"，而日志里那些点击的窗口内坐标（如 63,415）落在
//   她身体范围（x 172-412, y 344-553）之外 —— 必须分清是"主人点偏了"还是
//   "掩码里的她与画出来的她不是同一个位置"。启动后打一次坐标网格，一眼就能看出来。
{
  const L = s.split(/\r?\n/)
  const at = L.findIndex((l) => /webContents\.once\("did-finish-load"/.test(l))
  if (at < 0) throw new Error('找不到 did-finish-load（自检插入点）')
  L.splice(at + 1, 0,
    '    // 延迟一点，等模型与掩码都就绪',
    '    setTimeout(async () => {',
    '      try {',
    '        // 用字符串拼接而不是模板字面量：这段本身处在生成器的模板里，反引号会把它截断',
    '        var probe = "(function(){try{"',
    '          + \'var st=document.querySelector(".dshp-stage");\'',
    '          + \'var r=st?st.getBoundingClientRect():null;\'',
    '          + \'var info=window.DSHPet&&DSHPet.maskInfo?DSHPet.maskInfo():null;\'',
    '          + \'var pts=[[292,450],[200,415],[63,415],[250,573],[292,545],[292,360],[292,500],[230,480]];\'',
    '          // 严格（单点） vs 带放大（同 hitJS 的算法）—— 对比才能看出放大有没有解决问题',
    '          + \'function fuzzy(x,y){if(!(window.DSHPet&&DSHPet.hitTest))return false;if(DSHPet.hitTest(x,y))return true;var tt=info&&info.tight?info.tight:null;if(!tt||tt.w<=0)return false;var cx=tt.x+tt.w/2,cy=tt.y+tt.h/2;for(var st=1;st<=4;st++){var s=1.7*st/4;if(DSHPet.hitTest(Math.round(cx+(x-cx)/s),Math.round(cy+(y-cy)/s)))return true;}return false;}\'',
    '          + \'var out=pts.map(function(p){var s=false,f=false;try{s=!!(window.DSHPet&&DSHPet.hitTest(p[0],p[1]));f=fuzzy(p[0],p[1])}catch(e){};return p[0]+","+p[1]+" 严格="+(s?"TA":"AIR")+" 容差="+(f?"TA":"AIR")});\'',
    '          // 掩码字符图：把 128x112 的网格打成 32 行 x 64 列，直接看出她"在掩码里"长什么样',
    '          + \'var art="";\'',
    '          + \'try{var g=window.DSHPet&&DSHPet.maskGrid?DSHPet.maskGrid():null;if(g){var GW=g.w,GH=g.h,grid=g.grid;\'',
    '          + \'for(var ry=0;ry<28;ry++){var line="";for(var rx=0;rx<64;rx++){var x=Math.floor(rx*GW/64),y=Math.floor(ry*GH/28);line+=grid[y*GW+x]?"#":".";}art+=line+"\\\\n";}}}catch(e){art="ART-EXC "+e.message}\'',
    '          + \'return JSON.stringify({stage:r?{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}:null,tight:info&&info.tight?info.tight:null,pts:out,art:art});\'',
    '          + \'}catch(e){return "EXC "+e.message}})()\'',
    '        const j = await win.webContents.executeJavaScript(probe)',
    '        try {',
    '          const o = JSON.parse(j)',
    '          bootLog("命中自检: stage=" + JSON.stringify(o.stage) + " tight=" + JSON.stringify(o.tight))',
    '          bootLog("命中自检: " + o.pts.join("  "))',
    '          bootLog("掩码字符图(128x112 -> 64x28):\\n" + o.art)',
    '        } catch (e2) { bootLog("命中自检(原始): " + j) }',
    '      } catch (err) { bootLog("命中自检失败: " + String(err && err.message)) }',
    '    }, 2500)',
  )
  s = L.join('\n')
}
must(/命中自检: /.test(s), '命中自检没插进去')

fs.writeFileSync(path.join(OUT_DIR, 'main.js'), s, 'utf8')
console.log('写出 ' + path.join(OUT_DIR, 'main.js') + '（' + s.split('\n').length + ' 行）')
console.log('残留 ESM 语法（import/export）: ' + /^(import|export)\s/m.test(s))
{
  const code = s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  console.log('自检: setIgnoreMouseEvents=' + (code.match(/setIgnoreMouseEvents\s*\(/g) || []).length +
    ' pollTimer=' + (/pollTimer/.test(code) ? '在' : '无') +
    ' 自校正拖动=' + (/const STEP_MS = 33/.test(code) ? '在' : '丢') +
    ' preload诊断接收端=' + (/dshw-diag/.test(code) ? '在' : '丢') +
    ' 入口诊断=' + (/drag-start: at=/.test(code) ? '在' : '丢'))
}
