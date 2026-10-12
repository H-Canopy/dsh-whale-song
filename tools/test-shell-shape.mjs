// ============================================================================
// test-shell-shape.mjs —— 窗口成型器（window-shape.cjs）的行为守门员
// ----------------------------------------------------------------------------
// 不需要真 PowerShell：用一个「假 PS」记录它被怎么调用（DSHW_PS_EXE 接缝，见 window-shape.cjs:124）。
// 假 PS 用**编译出来的小 exe**（跨平台/跨机器都能跑，不需要 bash）：
//   · Unix/macOS：编译一个 C 小程序（cc 可用时）
//   · Windows   ：Add-Type 编译一个 C# 小程序（.NET 自带 csc）
//   两者行为一致：把「时间戳 + 全部参数」追加进日志，再往 stdout 打一行 OK。
// 守住的几件事（都是真机排查里踩出来的）：
//   1. 掩码**内容**变了（矩形没变）必须重新应用 —— 否则区域永远停在第一次提交的那一帧
//   2. 完全相同的形状不重复应用
//   3. 限频 + 合并：短时间连续来多个，只应用最后一个，且两次应用间隔 ≥ minGapMs
//   4. expand 是**膨胀**（传给 PS 的矩形不被拉大），并按 scaleFactor 换算成物理像素
//   5. 生成的 .ps1 必须纯 ASCII（PS 5.1 把无 BOM 的 UTF-8 当 ANSI 读，中文会吃掉引号）
// 跑：node tools/test-shell-shape.mjs
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
let pass = 0
let fail = 0
const failed = []
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log('  ok   ' + label) } else { fail++; failed.push(label); console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-shape-test-'))
const logFile = path.join(tmp, 'calls.log')

// —— 造一个「假 PS」可执行文件（真 exe，spawn 直接能跑）——
function buildFakePs() {
  const isWin = process.platform === 'win32'
  if (isWin) {
    const exe = path.join(tmp, 'fake-ps.exe')
    // C# 源码写成文件再编译（避免命令行转义问题）
    const cs = path.join(tmp, 'fake-ps.cs')
    fs.writeFileSync(cs, [
      'using System;',
      'using System.IO;',
      'using System.Text;',
      'public class FakePs {',
      '  public static int Main(string[] a) {',
      '    var sb = new StringBuilder();',
      '    sb.Append(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());',
      '    foreach (var s in a) { sb.Append(\' \'); sb.Append(s); }',
      '    File.AppendAllText(@"' + logFile.replace(/"/g, '""') + '", sb.ToString() + "\\n");',
      '    Console.Out.Write("OK rects=3 regionType=3\\n");',
      '    return 0;',
      '  }',
      '}',
    ].join('\n'), 'utf8')
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      'Add-Type -Path "' + cs.replace(/"/g, '""') + '" -OutputAssembly "' + exe.replace(/"/g, '""') + '" -OutputType ConsoleApplication'],
    { stdio: ['ignore', 'ignore', 'pipe'] })
    return exe
  }
  // Unix：编译一个 C 小程序
  const exe = path.join(tmp, 'fake-ps')
  const c = path.join(tmp, 'fake-ps.c')
  fs.writeFileSync(c, [
    '#include <stdio.h>',
    '#include <time.h>',
    'int main(int argc, char** argv) {',
    '  FILE* f = fopen("' + logFile + '", "a");',
    '  struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);',
    '  fprintf(f, "%lld", (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000);',
    '  for (int i = 1; i < argc; i++) fprintf(f, " %s", argv[i]);',
    '  fprintf(f, "\\n"); fclose(f);',
    '  printf("OK rects=3 regionType=3\\n");',
    '  return 0;',
    '}',
  ].join('\n'), 'utf8')
  execFileSync('cc', ['-O0', '-o', exe, c], { stdio: ['ignore', 'ignore', 'pipe'] })
  fs.chmodSync(exe, 0o755)
  return exe
}

let fakePs = null
try {
  fakePs = buildFakePs()
} catch (err) {
  console.log('无法构建「假 PS」可执行文件，本组测试跳过：' + (err && err.message))
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('\n结果：pass 0 / fail 0（跳过）')
  process.exit(0)
}
process.env.DSHW_PS_EXE = fakePs

const { createShaper } = require(path.join(HERE, '..', 'desktop', 'standalone', 'window-shape.cjs'))

const png = (tag) => 'data:image/png;base64,' + Buffer.from('fakepng-' + tag).toString('base64')
const shape = (tag, over) => Object.assign({ gw: 128, gh: 112, x: 166, y: 338, w: 252, h: 221, bits: png(tag) }, over || {})
const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [])
const argsOf = (line) => line.split(' ').slice(1)
const GAP = 150

const sh = createShaper({ getHwnd: () => 4242, getScale: () => 1.5, expand: 24, minGapMs: GAP, log: () => {} })

console.log('\n--- 应用与参数 ---')
sh.submit(shape('A'))
await sleep(400)
let c = calls()
ok(c.length === 1, '第一次提交 → 应用 1 次', 'calls=' + c.length)
const a = argsOf(c[0] || '')
// 参数序：-NoProfile -ExecutionPolicy Bypass -File <ps1> hwnd gw gh x y w h png pad
const tail = a.slice(a.indexOf('-File') + 2)
ok(tail[0] === '4242', 'hwnd 原样传入', tail[0])
ok(tail[3] === String(Math.round(166 * 1.5)) && tail[4] === String(Math.round(338 * 1.5)), '矩形位置按 scaleFactor 换成物理像素（不加 expand）', tail.slice(3, 5).join(','))
ok(tail[5] === String(Math.round(252 * 1.5)) && tail[6] === String(Math.round(221 * 1.5)), '矩形尺寸不被 expand 拉大（膨胀 ≠ 拉伸）', tail.slice(5, 7).join(','))
ok(tail[8] === String(Math.round(24 * 1.5)), 'expand 作为 pad 传给 PS（24 DIP → 36 物理像素）', tail[8])

console.log('\n--- 去重（含内容） ---')
sh.submit(shape('A'))
await sleep(GAP + 250)
ok(calls().length === 1, '完全相同的形状不重复应用', 'calls=' + calls().length)
sh.submit(shape('B'))
await sleep(GAP + 300)
ok(calls().length === 2, '矩形没变、掩码内容变了 → 必须重新应用', 'calls=' + calls().length)

console.log('\n--- 限频与合并 ---')
sh.submit(shape('C'))   // 空闲时第一个立刻应用（前沿）
sh.submit(shape('D'))   // D 被 E 覆盖，不该被应用（合并）
sh.submit(shape('E'))   // 限频等待结束后只应用最后这个（后沿）
await sleep(GAP * 3 + 400)
c = calls()
ok(c.length === 4, '连续提交 C/D/E → 只应用 C 和 E（D 被合并掉），累计 4 次', 'calls=' + c.length)
const ts = c.map((l) => Number(l.split(' ')[0]))
ok(ts.length >= 4 && ts[3] - ts[2] >= GAP - 20, '两次应用间隔 ≥ minGapMs', ts.length >= 4 ? String(Math.round(ts[3] - ts[2])) + 'ms' : '')
ok(sh.stats().applied === 4, 'stats().applied 与实际一致', String(sh.stats().applied))

console.log('\n--- 生成的 PS 脚本 ---')
const ps1 = a[a.indexOf('-File') + 1]
const src = fs.readFileSync(ps1)
ok(src.every((b) => b < 128), '.ps1 纯 ASCII（PS 5.1 读无 BOM UTF-8 会吃引号）')
const txt = src.toString('latin1')
ok(/\$pad = \[int\]\$args\[8\]/.test(txt) && /- \$pad/.test(txt) && /\+ \$pad/.test(txt), '脚本里有 pad 并对每个矩形做四向膨胀')
ok(txt.indexOf('param(') === -1, '脚本里没有 param()（放后面会报 ExpectedExpression）')
// 这条是「她只被裁到一部分」那个真 bug 的守门员，别删：
// powershell.exe 默认 DPI-unaware，Windows 会把它交给 SetWindowRgn 的坐标再乘 1/1.5
// （实测请求 (172,344) 240x209 pad0 → 实得 (140,242)-(272,355)，正好 ×0.667）。
// 必须由脚本自己先声明 DPI 感知，区域才是 1:1。
ok(/SetProcessDpiAwarenessContext/.test(txt) && /\[IntPtr\]\(-4\)/.test(txt),
  '辅助脚本先声明 DPI 感知（否则区域被系统再乘 1/1.5 → 只裁到她一部分）')

console.log('\n--- 页面侧（源码守门员） ---')
const petSrc = fs.readFileSync(path.join(HERE, '..', 'assets', 'pet.js'), 'utf8')
const uiSrc = fs.readFileSync(path.join(HERE, '..', 'desktop', 'standalone', 'ui', 'index.html'), 'utf8')
const shellSrc = fs.readFileSync(path.join(HERE, '..', 'desktop', 'standalone', 'main.js'), 'utf8')
const shaperSrc = fs.readFileSync(path.join(HERE, '..', 'desktop', 'standalone', 'window-shape.mjs'), 'utf8')
ok(/const SHELL_MASK_LIVE = !!window\.__DSHPET_SHELL__/.test(petSrc) && /MASK_REFRESH_MS/.test(petSrc), 'pet.js：壳模式下周期性重采掩码（否则掩码是一张定格快照）')
ok(/SHELL_MASK_LIVE && !mask\.dirty && !mask\.building && performance\.now\(\) - mask\.lastBuild > MASK_REFRESH_MS/.test(petSrc), 'pet.js：postrender 里按间隔把掩码标脏', '')
ok(/m\.bits\.length, hash\]/.test(uiSrc), 'ui/index.html：提交去重的 key 带掩码内容哈希（不只看 bits.length）')
// maskInfo 必须给出**实体紧包围盒**（tight）：壳拿它做区域才贴她本人。
// 只给画布矩形（含四周留白）会把一圈空气也裁成"可点"，死区白白变大。
ok(/tight:\s*tight/.test(petSrc) && /const sx = r\.width \/ mask\.w/.test(petSrc),
  'pet.js：maskInfo() 给出实体的 tight 紧包围盒（CSS 像素）')
ok(/shape\.tight && shape\.tight\.w > 0/.test(shaperSrc), 'window-shape：有 tight 就用 tight，没有才退回画布矩形')
// 区域是物理像素、页面给的是 CSS/DIP → 必须 ×scaleFactor（实测窗口 422x602 DIP = 632x902 物理）。
ok(/getScale: \(\) => \{/.test(shellSrc) && /scaleFactor/.test(shellSrc),
  'main.js：把显示器 scaleFactor 交给成型器（CSS → 物理像素）')
ok(/const S = \(n\) => Math\.round\(n \* sc\)/.test(shaperSrc),
  'window-shape：区域坐标按 scale 换算成物理像素')

// ⑥ 【生成物必须在仓库里能找到生成器】
//   历史：main.js / preload.js / *.cjs 都是生成的，但生成器只存在于作者机器的
//   D:\Bigfish\_staging\（不在仓库里）—— 于是 clone 下来的人拿到的是一堆
//   "改了会被覆盖、却找不到生成器"的黑盒。现在生成器进了 tools/shell-gen/。
{
  const genDir = path.join(HERE, '..', 'tools', 'shell-gen')
  const need = [
    'make-standalone-shell.mjs',    // → desktop/standalone/main.js + preload.js
    'make-shell-cjs-shape.mjs',     // → window-shape.cjs
    'make-shell-cjs-server.mjs',    // → server.cjs
    'make-shell-cjs-bridge.mjs',    // → media-bridge.cjs
  ]
  ok(need.every((f) => fs.existsSync(path.join(genDir, f))),
    '生成器都在仓库里（tools/shell-gen/）—— 否则生成物就是改不了的黑盒', '')
  const genBad = need
    .map((f) => [f, fs.readFileSync(path.join(genDir, f), 'utf8')])
    .filter(([, src]) => /D:[\\/]Plugins[\\/]dsh-whale-song/.test(src))
    .map(([f]) => f)
  ok(genBad.length === 0, '生成器不写死绝对路径（clone 到别的机器也能跑）', genBad.join(','))
  // 探针也在仓库里（排查窗口/成型问题时离不开）
  const probeDir = path.join(HERE, '..', 'tools', 'probe')
  const probes = fs.existsSync(probeDir)
    ? fs.readdirSync(probeDir).filter((f) => f.endsWith('.ps1'))
    : []
  ok(probes.length >= 5, '排查探针在仓库里（tools/probe/，实测 ' + probes.length + ' 个）', '')
  // ① 编码：非 ASCII 的 .ps1 **必须带 UTF-8 BOM**。
  //    PS 5.1 把无 BOM 的 UTF-8 当 ANSI 读 → 中文会把引号吃掉 → 语法错误。真踩过。
  const noBom = probes.filter((f) => {
    const b = fs.readFileSync(path.join(probeDir, f))
    const nonAscii = b.some((x) => x > 127)
    const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
    return nonAscii && !bom
  })
  ok(noBom.length === 0, '含中文的探针都带 UTF-8 BOM（否则 PS 5.1 读出乱码 + 语法错）', noBom.join(','))
  // ② DPI 感知：**读区域/窗口坐标**的探针必须自己声明感知，否则读到的是逻辑坐标，
  //    会把一个正确的区域误报成"缩小了 0.667 倍"（这个幻觉害我绕了好几轮）。
  //    probe-rgn-cal.ps1 是**故意**不声明的（它量的就是 unaware 场景），
  //    probe-ps-dpi.ps1 量的就是"默认感知级别"，同理豁免。
  const mustBeAware = ['probe-rgn-exact.ps1', 'probe-rgn-cal-aware.ps1', 'list-windows.ps1', 'probe-cursor.ps1']
  const notAware = mustBeAware
    .filter((f) => probes.includes(f))
    .filter((f) => !/SetProcessDpiAwarenessContext/.test(fs.readFileSync(path.join(probeDir, f), 'utf8')))
  ok(notAware.length === 0, '读窗口/区域坐标的探针都声明了 DPI 感知', notAware.join(','))
}

console.log('\n--- 尺寸稳定性（真机教训） ---')
// 真机：窗口尺寸在多次拖动间累积增长（50 次 422→440）。实测 4 组对照后确定：
// 拖动位置量化到**偶数**才不涨（量化到 1.5 的倍数仍涨 2px；只用 setPosition 会暴涨 60px）。
// （shellSrc 已在上面页面侧那段读好了）
ok(/const x2 = c\.x - \(c\.x % 2\), y2 = c\.y - \(c\.y % 2\)/.test(shellSrc),
  '拖动位置量化到偶数（实测只有这样窗口尺寸才不涨 → 画布不 resize → 不闪）', '')

sh.cleanup()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) {}
console.log('\n结果：pass ' + pass + ' / fail ' + fail)
if (fail) { console.log('失败项：'); failed.forEach((f) => console.log('  - ' + f)) }
process.exit(fail ? 1 : 0)
