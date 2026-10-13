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
  const panelSelector = '.dshp-panel,.dshp-menu,.dshp-hud,.dshp-bubble,.dshp-composer,.dshp-dock,.dshp-tab,.dshp-mail'
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
    if (input) latestBody = input.body
    const tab = document.querySelector('.dshp-tab')
    if (tab) {
      const anchor = latestBody || rect(stage)
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
    native.input({ body: input.body, mask: input.mask, panels, status: pet.state.agent.status, lowPower: pet.isLowPower(), roamBlocked })
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
    down = { x: e.screenX, y: e.screenY, dx: 0, dy: 0, moved: false, target: e.target, id: e.pointerId }
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
    if (e.type === 'pointerup' && was.moved) {
      was.dx = e.screenX - was.x
      was.dy = e.screenY - was.y
    }
    native.dragEnd({ dx: was.moved ? was.dx : 0, dy: was.moved ? was.dy : 0 })
    try { was.target.releasePointerCapture(was.id) } catch {}
    if (was.moved) {
      suppressTabClick = !!was.target.closest?.('.dshp-tab')
      e.preventDefault(); e.stopImmediatePropagation()
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
