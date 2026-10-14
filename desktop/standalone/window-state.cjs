'use strict'

// All geometry is in Electron DIP / browser CSS pixels. No physical-pixel conversion.
const DEFAULT_BODY = { x: 170, y: 342, w: 240, h: 210 }
const finite = (n) => Number.isFinite(n)
const even = (n) => Math.round(n / 2) * 2

function clampWindow(position, body, areas, pad = 8, quantize = true) {
  const b = body || DEFAULT_BODY
  const center = { x: position.x + b.x + b.w / 2, y: position.y + b.y + b.h / 2 }
  const distance = (a) => Math.max(a.x - center.x, 0, center.x - a.x - a.width) ** 2
    + Math.max(a.y - center.y, 0, center.y - a.y - a.height) ** 2
  const a = areas.reduce((best, next) => distance(next) < distance(best) ? next : best)
  const fit = (v, lo, hi) => {
    const clamped = Math.max(lo, Math.min(Math.max(lo, hi), v))
    return quantize ? even(clamped) : clamped
  }
  return {
    x: fit(position.x, a.x + pad - b.x, a.x + a.width - pad - b.x - b.w),
    y: fit(position.y, a.y + pad - b.y, a.y + a.height - pad - b.y - b.h),
  }
}

// Consume INPUT deltas even when clamped: returning from an edge responds immediately.
function beginDrag(bounds) {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, dx: 0, dy: 0 }
}
function advanceDrag(drag, dx, dy, body, areas) {
  if (!finite(dx) || !finite(dy)) return null
  // Retain sub-pixel input between frames; rounding every incremental move loses slow drags.
  const next = clampWindow({ x: drag.x + dx - drag.dx, y: drag.y + dy - drag.dy }, body, areas, 8, false)
  drag.dx = dx
  drag.dy = dy
  drag.x = next.x
  drag.y = next.y
  return { x: even(next.x), y: even(next.y), width: drag.width, height: drag.height }
}

function savedPosition(bounds, body, areas) {
  const p = { x: bounds.x + body.x, y: bounds.y + body.y }
  const area = areas.find((a) => p.x + body.w / 2 >= a.x && p.x + body.w / 2 <= a.x + a.width
    && p.y + body.h / 2 >= a.y && p.y + body.h / 2 <= a.y + a.height) || areas[0]
  // 同时存**窗口位置** wx/wy 与 body 屏幕锚点 bodyX/bodyY：
  //   · 有 wx/wy 时还原是无损往返（存哪就回哪），不会算出负的窗口 y —— 见 restorePosition 的注释；
  //   · bodyX/bodyY 继续保留，老存档（没有 wx/wy）仍走原来的换算路径，跨分辨率也能用。
  return { version: 2, wx: bounds.x, wy: bounds.y, bodyX: p.x, bodyY: p.y, workArea: area }
}
function restorePosition(saved, body, areas, fallback) {
  if (Array.isArray(saved) && saved.length === 2 && saved.every(finite)) {
    return clampWindow({ x: saved[0], y: saved[1] }, body, areas)
  }
  if (saved && saved.version === 2 && finite(saved.bodyX) && finite(saved.bodyY)) {
    // ⚠️ 优先用**窗口位置**（version 2 的新字段），别再靠"bodyY − body.y"反推。
    //
    // 为什么：只存 body 屏幕锚点时，还原式 `y = bodyY − body.y` **必然可能为负** ——
    // body.y 在窗口内是 342，所以只要存下来的 bodyY < 342（她当时靠屏幕上方），
    // 算出来就是负的窗口 y，**头被切掉**。真机事故（2026-10-14）：
    // pos.json 存 bodyY=148 → 窗口 y = 148 − 342 = **−194**，她头顶出屏、可点区域只剩 2/7。
    //
    // 窗口位置是**无损往返**的：存的时候窗口在哪，还原就还在哪（再夹一次即可）。
    // bodyX/bodyY 仍然保留并参与跨分辨率换算的兼容路径（老存档没有 wx/wy）。
    let wx = saved.wx
    let wy = saved.wy
    if (!finite(wx) || !finite(wy)) {
      let p = { x: saved.bodyX, y: saved.bodyY }
      const previous = saved.workArea
      if (previous && previous.width > 0 && previous.height > 0) {
        const next = areas.find((a) => a.x === previous.x && a.y === previous.y) || areas[0]
        p.x = next.x + (p.x - previous.x) * next.width / previous.width
        p.y = next.y + (p.y - previous.y) * next.height / previous.height
      }
      wx = p.x - body.x
      wy = p.y - body.y
    }
    return clampWindow({ x: wx, y: wy }, body, areas)
  }
  return clampWindow(fallback, body, areas)
}

module.exports = { DEFAULT_BODY, clampWindow, beginDrag, advanceDrag, savedPosition, restorePosition }
