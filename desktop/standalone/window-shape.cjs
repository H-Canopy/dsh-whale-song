// ============================================================================
// window-shape.mjs（壳侧）—— 把窗口裁成「她的轮廓」（Win32 SetWindowRgn）
// ----------------------------------------------------------------------------
// 为什么要有它：矩形透明窗口里，"鼠标在不在她身上"只能**猜**（定时轮询 + JS 命中测试），
// 而轮询有空窗 —— 指针刚移到她身上、还没轮到下一次轮询时按下去，那一下就穿透掉了，
// 表现就是"有时候抓不住她"。实测（见 _staging/demo-rgn-02/03）：
//   · 用 Win32 区域把窗口裁成她的轮廓后，**轮廓外的点击由操作系统直接交给下面的窗口**，
//     轮廓内的点击**稳定**到达她 —— 没有空窗，也不需要 setIgnoreMouseEvents。
//   · 掩码→区域 重建一次约 10ms（60×109 网格、按行合并矩形），只在尺寸/缩放变化时才做。
//
// 实现方式（不引入 FFI 依赖）：起一个 PowerShell 只调一次 Win32。脚本里**全部是 ASCII** ——
// powershell.exe(5.1) 把无 BOM 的 UTF-8 当 ANSI 读，中文会吃掉引号导致语法错误（踩过两次）。
//
// 线程模型：永远只有**一次**「应用」在跑；期间来的新请求只保留**最后一个**（合并），
// 所以拖缩放滑块不会排起长队。
// ============================================================================
'use strict'
// ⚠️ 生成物：由 window-shape.mjs 机械转换而来（理由见那个文件头）。
// 要改逻辑请改 .mjs，然后重新生成：node D:\Bigfish\_staging\make-shell-cjs-shape.mjs
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

/**
 * 生成那个只做一件事的 PS 助手脚本（ASCII only）。
 * 输入（参数）：hwnd、gw、gh、矩形 x/y/w/h、掩码 PNG 路径。
 * 做法：读 PNG 的像素（System.Drawing）→ 逐行把连续的实心格合并成矩形 →
 *       CreateRectRgn + CombineRgn(OR) 拼成一个复杂区域 → SetWindowRgn(hwnd, rgn, redraw)。
 * 关键：SetWindowRgn **成功后会接管该区域的释放**，所以成功时不能 DeleteObject（否则区域被提前释放）。
 */
function helperSource() {
  return [
    "$ErrorActionPreference = 'Stop'",
    // ⚠️ 不要在这里写 param()：param() 必须出现在脚本的**第一条可执行语句之前**，
    //    放在后面会直接报 "ExpectedExpression"（踩过）。-File 传进来的位置参数用 $args 取即可。
    '$hwnd = [Int64]$args[0]',
    '$gw = [int]$args[1]',
    '$gh = [int]$args[2]',
    '$rx = [int]$args[3]',
    '$ry = [int]$args[4]',
    '$rw = [int]$args[5]',
    '$rh = [int]$args[6]',
    '$png = [string]$args[7]',
    '$pad = [int]$args[8]',
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class WShape {',
    '  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);',
    '  [DllImport("gdi32.dll")] public static extern int CombineRgn(IntPtr dst, IntPtr a, IntPtr b, int mode);',
    '  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);',
    '  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);',
    '  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hWnd, IntPtr hRgn);',
    '}',
    '\'@',
    '$bmp = [System.Drawing.Bitmap]::FromFile($png)',
    'try {',
    '  $master = [WShape]::CreateRectRgn(0, 0, 0, 0)',
    '  $rects = 0',
    '  $sx = $rw / $gw',
    '  $sy = $rh / $gh',
    '  for ($gy = 0; $gy -lt $gh; $gy++) {',
    '    $gx = 0',
    '    while ($gx -lt $gw) {',
    '      $c = $bmp.GetPixel($gx, $gy)',
    '      if ($c.R -gt 127) {',
    '        $gx0 = $gx',
    '        while ($gx -lt $gw -and $bmp.GetPixel($gx, $gy).R -gt 127) { $gx++ }',
    '        $x0 = [int][math]::Round($rx + $gx0 * $sx) - $pad',
    '        $x1 = [int][math]::Round($rx + $gx * $sx) + $pad',
    '        $y0 = [int][math]::Round($ry + $gy * $sy) - $pad',
    '        $y1 = [int][math]::Round($ry + ($gy + 1) * $sy) + $pad',
    '        if ($x1 -le $x0) { $x1 = $x0 + 1 }',
    '        if ($y1 -le $y0) { $y1 = $y0 + 1 }',
    '        $r = [WShape]::CreateRectRgn($x0, $y0, $x1, $y1)',
    '        [void][WShape]::CombineRgn($master, $master, $r, 2)',
    '        [void][WShape]::DeleteObject($r)',
    '        $rects++',
    '      } else { $gx++ }',
    '    }',
    '  }',
    '  $res = [WShape]::SetWindowRgn([IntPtr]$hwnd, $master, $true)',
    '  if ($res -eq 0) { [void][WShape]::DeleteObject($master); Write-Output ("ERR set-window-rgn-failed rects=" + $rects); exit 1 }',
    '  $probe = [WShape]::CreateRectRgn(0,0,1,1)',
    '  $gr = [WShape]::GetWindowRgn([IntPtr]$hwnd, $probe)',
    '  [void][WShape]::DeleteObject($probe)',
    '  Write-Output ("OK rects=" + $rects + " regionType=" + $gr)',
    '} finally { $bmp.Dispose() }',
  ].join('\n') + '\n'
}

/** 把 data:image/png;base64,... 落盘（PS 的 System.Drawing 只能从文件读） */
function writeMaskPng(dataUrl, dir) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
  if (!m) throw new Error('掩码不是 PNG data URL')
  const buf = Buffer.from(m[1], 'base64')
  if (!buf.length || buf.length > 1024 * 1024) throw new Error('掩码大小异常')
  const file = path.join(dir, 'mask.png')
  fs.writeFileSync(file, buf)
  return file
}

/**
 * 建一个"窗口成型器"。
 * @param {object} opts
 * @param {() => (number|null)} opts.getHwnd 取窗口 HWND（Electron: win.getNativeWindowHandle()）
 * @param {number} [opts.expand] 掩码向外膨胀的像素（阴影/光晕不该被切掉时用；默认 0）
 * @param {(msg:string)=>void} [opts.log] 日志
 */
function createShaper(opts) {
  const o = opts || {}
  const getHwnd = o.getHwnd
  /** 窗口所在显示器的缩放（CSS→物理像素）。不给就按 1（不缩放）。 */
  const getScale = typeof o.getScale === 'function' ? o.getScale : () => 1
  /** 轮廓向外**膨胀**的 DIP 数（阴影/光晕/姿势漂移的余量）。注意：是膨胀，不是把矩形拉大——后者会把轮廓拉伸变形。 */
  const expand = Number.isFinite(o.expand) ? o.expand : 0
  /** 两次「应用」之间至少隔多久（每次都要起一个 PowerShell，她一直在动，不限频会吃满 CPU） */
  const minGapMs = Number.isFinite(o.minGapMs) ? o.minGapMs : 500
  const log = typeof o.log === 'function' ? o.log : () => {}
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-shape-'))
  const psFile = path.join(dir, 'shape.ps1')
  const psExe = process.env.DSHW_PS_EXE
    || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  fs.writeFileSync(psFile, helperSource(), 'utf8')

  let running = false
  let pending = null
  let lastKey = ''
  let lastResult = null
  let applied = 0
  let lastApplyAt = 0

  /**
   * 「同一个形状」的判据。⚠️ 必须带**掩码内容**：她换姿势后轮廓变了、舞台矩形没变，
   * 只比矩形会把新轮廓当成旧的丢掉（区域就永远停在第一次提交的那一帧）。
   */
  function keyOf(s) {
    const b = String(s.bits || '')
    let h = 0
    for (let i = 0; i < b.length; i += 3) h = (h * 31 + b.charCodeAt(i)) | 0
    return [s.gw, s.gh, s.x, s.y, s.w, s.h, b.length, h].join(',')
  }

  function applyOnce(shape) {
    return new Promise((resolve) => {
      let png
      try { png = writeMaskPng(shape.bits, dir) } catch (err) { resolve({ ok: false, error: String(err && err.message) }); return }
      // maskBbox 诊断：把掩码 PNG 的字节数也写进 detail，便于核对"提交的掩码是不是这份"。
      // ⚠️ 这段必须留在 .mjs 里（.cjs 是它的机械生成物）。以前它只写在生成器里，
      //    结果 .cjs 有、.mjs 没有 —— 一次重新生成就会把诊断丢掉（架构债，已还）。
      let maskBbox = null
      try {
        const bb = fs.readFileSync(png)
        maskBbox = { bytes: bb.length }
      } catch (err) {}
      const hwnd = getHwnd()
      if (!hwnd) { resolve({ ok: false, error: 'no-hwnd' }); return }
      // ⚠️ 单位换算（实测）：页面给的是 **CSS 像素 = DIP**（窗口 422×602 DIP ↔ innerWidth 422），
      //    而 SetWindowRgn 收的是**物理像素**（同一台机器 150% 缩放，实测区域正好被缩了 1/1.5）。
      //    所以要乘显示器的 scaleFactor。getScale() 由壳提供（按窗口所在显示器取）。
      let k = 1
      try { k = Number(getScale()) || 1 } catch (err) { k = 1 }
      if (!(k > 0)) k = 1
      const args = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile,
        String(hwnd), String(shape.gw), String(shape.gh),
        String(Math.round(shape.x * k)), String(Math.round(shape.y * k)),
        String(Math.round(shape.w * k)), String(Math.round(shape.h * k)),
        png,
        String(Math.round(expand * k)),
      ]
      let child
      try {
        child = spawn(psExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        resolve({ ok: false, error: 'spawn-failed: ' + String(err && err.message) })
        return
      }
      let out = ''
      let errOut = ''
      let done = false
      const settle = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v) } }
      const t = setTimeout(() => { try { child.kill() } catch (e) {} settle({ ok: false, error: 'timeout' }) }, 8000)
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { errOut += d })
      child.on('error', (e) => settle({ ok: false, error: 'spawn-failed: ' + String(e && e.message) }))
      child.on('close', (code) => {
        const line = String(out).trim().split(/\r?\n/).filter(Boolean).pop() || ''
        if (code === 0 && /^OK /.test(line)) settle({ ok: true, detail: line + ' | mask=' + JSON.stringify(maskBbox) + ' | in=' + JSON.stringify({ hwnd: hwnd, gw: shape.gw, gh: shape.gh, x: Math.round(shape.x), y: Math.round(shape.y), w: Math.round(shape.w), h: Math.round(shape.h), pad: expand }) })
        else settle({ ok: false, error: line || ('exit ' + code), diag: String(errOut).slice(-300) })
      })
    })
  }

  async function pump() {
    if (running) return
    running = true
    try {
      while (pending) {
        // 限频：等够间隔再取「最新」的那个（等的这段时间里新来的会覆盖 pending，天然合并）
        const wait = lastApplyAt + minGapMs - Date.now()
        if (wait > 0) await new Promise((res) => setTimeout(res, wait))
        const shape = pending
        pending = null
        if (!shape) continue
        const key = keyOf(shape)
        if (key === lastKey) continue          // 同一个形状（含内容），不重复裁
        const r = await applyOnce(shape)
        lastApplyAt = Date.now()
        if (r.ok) { lastKey = key; applied++; lastResult = r; log('窗口已成型：' + r.detail) }
        else log('窗口成型失败：' + r.error + (r.diag ? ' | ' + r.diag : ''))
      }
    } finally {
      running = false
      if (pending) pump()
    }
  }

  return {
    /** 提交一个新形状（来自页面 maskInfo()）。合并式：只保留最后一个。 */
    submit(shape) {
      if (!shape || !shape.bits || !(shape.gw > 0) || !(shape.gh > 0)) return { ok: false, error: 'bad-shape' }
      pending = shape
      pump()
      return { ok: true, queued: true }
    },
    /** 回到矩形窗口（例如掩码拿不到时）。注意：SetWindowRgn(hwnd, NULL) 会清掉区域。 */
    async clear() {
      lastKey = ''
      const hwnd = getHwnd()
      if (!hwnd) return { ok: false, error: 'no-hwnd' }
      const child = spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        'Add-Type @"\nusing System;\nusing System.Runtime.InteropServices;\npublic class WC { [DllImport(\\"user32.dll\\")] public static extern int SetWindowRgn(IntPtr h, IntPtr r, bool b); }\n"@; [void][WC]::SetWindowRgn([IntPtr]' + hwnd + ', [IntPtr]::Zero, $true); Write-Output OK'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      return new Promise((resolve) => {
        let out = ''
        child.stdout.on('data', (d) => { out += d })
        child.on('close', () => resolve({ ok: /OK/.test(out) }))
        child.on('error', (e) => resolve({ ok: false, error: String(e && e.message) }))
      })
    },
    stats() { return { applied: applied, lastResult: lastResult, lastKey: lastKey } },
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (err) {} },
  }
}

module.exports = { createShaper }
