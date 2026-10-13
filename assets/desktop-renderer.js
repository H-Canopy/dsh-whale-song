// Desktop-only native input bridge. Does not synthesize mouse events for gaze tracking.
;(function () {
  'use strict'
  const native = window.dshPetNative
  if (!native) return
  let down = null
  let lastMaskAt = -1
  let latestBody = null
  let nativeVisible = true
  let suppressTabClick = false
  let lastTap = null
  // ⚠️ 这里**不能**放 `.dshp-bubble`（对话气泡）。
  // 气泡是 `position:absolute; left:50%; bottom:100%` —— 悬在她**头顶上方居中**，而且是
  // `pointer-events:auto`。而主进程的 hitKind 与渲染进程的 kind() 都是"**面板优先于她**"，
  // 于是气泡一显示，点到气泡就变成点到面板 ⇒ **点不到她也拖不动她**。
  // 真机事故（2026-10-13）就是这条：用户报"点不了、也拖不动了，刚刚还是好的" ——
  // 气泡弹出来之后就失效，气泡消失又好了。
  // 气泡纯显示文字、**没有任何自己的点击处理器**，会随 ttl 自动消失，所以直接让它穿透。
  //
  // ⚠️ 这里**也不能**放 `.dshp-tab`：「大肥鱼」恢复标签在收起态被放到她身体**底部居中**，
  // 同样会跟她重叠并抢走点击。收起态只用 `collapsed: true` + 单独的 tab 矩形上报
  // （见下面 report() 的提前返回分支），不需要它出现在这个集合里。
  const panelSelector = '.dshp-panel,.dshp-menu,.dshp-hud,.dshp-composer,.dshp-dock,.dshp-mail'
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  }
  function report() {
    const pet = window.DSHPet
    const stage = document.querySelector('.dshp-stage')
    if (!pet || !stage || !pet.inputSnapshot) return
    const input = pet.inputSnapshot(lastMaskAt)
    if (input?.mask) lastMaskAt = input.maskAt
    if (input) latestBody = input.model || input.body
    const tab = document.querySelector('.dshp-tab')
    if (tab) {
      const anchor = input?.body || latestBody || rect(stage)
      const position = {
        left: Math.max(8, Math.min(innerWidth - tab.offsetWidth - 8, anchor.x + anchor.w / 2 - tab.offsetWidth / 2)) + 'px',
        top: Math.max(8, Math.min(innerHeight - 40, anchor.y + anchor.h - 32)) + 'px', right: 'auto', bottom: 'auto',
      }
      for (const [key, value] of Object.entries(position)) if (tab.style[key] !== value) tab.style[key] = value
    }
    if (!nativeVisible || document.body.classList.contains('dshp-pet-hidden')) {
      native.input({ collapsed: true, panels: tab && getComputedStyle(tab).display !== 'none' ? [rect(tab)] : [] })
      return
    }
    if (!input) return
    const panels = Array.from(document.querySelectorAll(panelSelector)).filter((el) => {
      const cs = getComputedStyle(el)
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05
        && cs.pointerEvents !== 'none' && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0
    }).map(rect)
    const roamBlocked = !!document.querySelector('.dshp-menu.dshp-on,.dshp-composer.dshp-on,.dshp-hud.dshp-on,.dshp-panel.dshp-on')
    native.input({ body: input.body, model: input.model, mask: input.mask, panels, status: pet.state.agent.status, lowPower: pet.isLowPower(), roamBlocked })
  }
  function kind(x, y, target) {
    if (!nativeVisible || document.body.classList.contains('dshp-pet-hidden')) return target?.closest('.dshp-tab') ? 'tab' : 'none'
    if (target && target.closest && target.closest(panelSelector)) return 'panel'
    if (!window.DSHPet || !latestBody || x < latestBody.x || y < latestBody.y
      || x > latestBody.x + latestBody.w || y > latestBody.y + latestBody.h) return 'none'
    if (DSHPet.hitTest(x, y)) return 'model'
    for (const dx of [-5, 0, 5]) for (const dy of [-5, 0, 5]) if (DSHPet.hitTest(x + dx, y + dy)) return 'model'
    return 'none'
  }
  window.addEventListener('pointerdown', (e) => {
    if (native.traceInput) native.traceInput({ type: 'pointerdown', x: e.clientX, y: e.clientY })
    if (e.button !== 0 || !['model', 'tab'].includes(kind(e.clientX, e.clientY, e.target))) return
    down = { x: e.screenX, y: e.screenY, dx: 0, dy: 0, moved: false, kind: kind(e.clientX, e.clientY, e.target), target: e.target, id: e.pointerId }
    try { e.target.setPointerCapture(e.pointerId) } catch {}
    native.dragStart({ x: e.clientX, y: e.clientY })
  }, true)
  window.addEventListener('mousedown', (e) => { if (native.traceInput) native.traceInput({ type: 'mousedown', x: e.clientX, y: e.clientY }) }, true)
  window.addEventListener('pointermove', (e) => {
    if (!down) { native.hover({ x: e.clientX, y: e.clientY }); return }
    if (!(e.buttons & 1)) { native.dragEnd({ dx: down.dx, dy: down.dy }); down = null; return }
    down.dx = e.screenX - down.x
    down.dy = e.screenY - down.y
    if (Math.hypot(down.dx, down.dy) < 4 && !down.moved) return
    down.moved = true
    native.dragMove({ dx: down.dx, dy: down.dy })
    e.preventDefault()
  }, true)
  function release(e) {
    if (!down) return
    const was = down
    down = null
    if (e.type === 'pointerup') {
      was.dx = e.screenX - was.x
      was.dy = e.screenY - was.y
      if (Math.hypot(was.dx, was.dy) >= 4) was.moved = true
    }
    native.dragEnd({ dx: was.moved ? was.dx : 0, dy: was.moved ? was.dy : 0 })
    try { was.target.releasePointerCapture(was.id) } catch {}
    if (was.moved) {
      lastTap = null
      suppressTabClick = !!was.target.closest?.('.dshp-tab')
      e.preventDefault(); e.stopImmediatePropagation()
    } else if (e.type === 'pointerup' && was.kind === 'model') {
      const now = performance.now()
      const double = lastTap && now - lastTap.at <= 500 && Math.hypot(e.screenX - lastTap.x, e.screenY - lastTap.y) <= 8
      lastTap = double ? null : { at: now, x: e.screenX, y: e.screenY }
      if (native.traceInput) native.traceInput({ type: double ? 'double-tap' : 'poke', x: e.clientX, y: e.clientY })
      window.DSHPet?.desktopClick(e.clientX, e.clientY, !!double)
    } else {
      lastTap = null
    }
  }
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
  // Browsers synthesize click after a dragged pointerup; dragging the tab must not expand it.
  window.addEventListener('click', (e) => {
    if (!suppressTabClick) return
    suppressTabClick = false
    if (e.target?.closest('.dshp-tab')) { e.preventDefault(); e.stopImmediatePropagation() }
  }, true)
  const wantsInput = (el) => !!(nativeVisible && el && (el.matches('input,textarea,select') || el.isContentEditable)
    && !el.closest('.dshp-hidden') && (!el.closest('.dshp-composer') || el.closest('.dshp-composer').classList.contains('dshp-on')))
  const syncFocus = (activate = false) => native.focusInput(wantsInput(document.activeElement), activate)
  window.addEventListener('focusin', () => syncFocus(), true)
  window.addEventListener('focusout', () => setTimeout(() => syncFocus(), 0), true)
  window.addEventListener('pointerdown', (e) => { if (wantsInput(e.target)) native.focusInput(true, true) }, true)
  window.addEventListener('compositionstart', (e) => {
    if (!wantsInput(e.target)) return
    if (native.composition) native.composition(true)
  }, true)
  window.addEventListener('compositionend', () => {
    if (native.composition) native.composition(false)
    setTimeout(() => syncFocus(), 0)
  }, true)
  if (native.onVisibility) native.onVisibility((visible) => {
    nativeVisible = visible === true
    down = null
    lastTap = null
    if (window.DSHPet) {
      DSHPet.setHidden(!nativeVisible, false)
      if (nativeVisible && DSHPet.resumeDesktop) DSHPet.resumeDesktop()
    }
    lastMaskAt = -1
    syncFocus()
    report()
  })
  native.onCursor((p) => { if (window.DSHPet && DSHPet.trackDesktopCursor) DSHPet.trackDesktopCursor(p.x, p.y) })
  setInterval(report, 200)
  let scheduled = false
  new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    setTimeout(() => { scheduled = false; report() }, 40)
  }).observe(document.body, { childList: true, attributes: true, subtree: true, attributeFilter: ['class', 'style'] })
})()
