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
  return { version: 2, bodyX: p.x, bodyY: p.y, workArea: area }
}
function restorePosition(saved, body, areas, fallback) {
  if (Array.isArray(saved) && saved.length === 2 && saved.every(finite)) {
    return clampWindow({ x: saved[0], y: saved[1] }, body, areas)
  }
  if (saved && saved.version === 2 && finite(saved.bodyX) && finite(saved.bodyY)) {
    let p = { x: saved.bodyX, y: saved.bodyY }
    const previous = saved.workArea
    if (previous && previous.width > 0 && previous.height > 0) {
      const next = areas.find((a) => a.x === previous.x && a.y === previous.y) || areas[0]
      p.x = next.x + (p.x - previous.x) * next.width / previous.width
      p.y = next.y + (p.y - previous.y) * next.height / previous.height
    }
    return clampWindow({ x: p.x - body.x, y: p.y - body.y }, body, areas)
  }
  return clampWindow(fallback, body, areas)
}

module.exports = { DEFAULT_BODY, clampWindow, beginDrag, advanceDrag, savedPosition, restorePosition }
