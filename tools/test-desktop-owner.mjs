// Real Chromium test: only one renderer owns the pet, with automatic fallback after shell exit/crash.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startPetServer } from '../desktop/standalone/server.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const browser = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].filter(Boolean).find(fs.existsSync)
if (!browser) throw new Error('Chromium is required for the ownership acceptance test')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-owner-browser-'))
let active = true
let hostBase = null
const fakeLink = { status: () => ({ connected: true, base: hostBase }), onChange: () => () => {}, forward: () => false }
const owner = await startPetServer({ repoRoot: root, dshLink: fakeLink, ownerPath: '/dsh-pet/owner/abc123', ownerActive: () => active })
const hostLink = {
  status: () => ({ connected: false, base: null }), onChange: () => () => {},
  forward: (req, res) => {
    if (req.url !== '/dsh-pet/config') return false
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ enabled: true, desktopEndpoint: owner.petBase + '/dsh-pet/owner/abc123' }))
    return true
  },
}
const host = await startPetServer({ repoRoot: root, dshLink: hostLink })
hostBase = host.petBase
const child = spawn(browser, ['--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--remote-debugging-port=0', '--user-data-dir=' + temp, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
let ws
let pass = 0
try {
  let debugPort
  for (let i = 0; i < 80 && !debugPort; i++) {
    try { debugPort = Number(fs.readFileSync(path.join(temp, 'DevToolsActivePort'), 'utf8').split('\n')[0]) } catch {}
    if (!debugPort) await sleep(100)
  }
  if (!debugPort) throw new Error('Browser did not start')
  const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()
  ws = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => { const data = JSON.parse(String(event.data)); if (pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id) } })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const request = ++id
    const timer = setTimeout(() => { pending.delete(request); reject(new Error('CDP timeout: ' + method)) }, 15000)
    pending.set(request, (data) => { clearTimeout(timer); data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result) })
    ws.send(JSON.stringify({ id: request, method, params }))
  })
  const ev = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  const waitFor = async (expression) => {
    for (let i = 0; i < 100; i++) { if (await ev(expression)) return; await sleep(150) }
    const details = await ev(`({ready:document.readyState,error:window.__DSHPetError||null,shell:window.__DSHPET_SHELL__,bridge:!!window.dshPetNative,visibility:!!window.__deliverVisibility,root:document.querySelector('.dshp-root')?.className,canvas:document.querySelector('canvas')?.width})`)
    throw new Error('Condition failed: ' + expression + ' ' + JSON.stringify(details))
  }
  const check = (name, condition) => { assert(condition, name); pass++; console.log('  ok ' + name) }
  await send('Page.navigate', { url: host.petBase + '/dsh-pet/app' })
  await waitFor('window.__DSH_DESKTOP_OWNED__ === true')
  check('DSH page does not create a second model while the desktop owns it', await ev('!document.querySelector(".dshp-root") && !DSHPet.state.modelSize'))
  active = false
  await waitFor('window.__DSH_DESKTOP_OWNED__ === false && !!DSHPet.state.modelSize && !!DSHPet.inputSnapshot()')
  check('DSH page renders the pet when the desktop releases ownership', await ev('!window.__DSHPetError && getComputedStyle(document.querySelector(".dshp-root")).display !== "none"'))
  active = true
  await waitFor('window.__DSH_DESKTOP_OWNED__ === true')
  check('desktop reconnect hides the existing DSH model', await ev('getComputedStyle(document.querySelector(".dshp-root")).display === "none"'))
  owner.close()
  await waitFor('window.__DSH_DESKTOP_OWNED__ === false')
  check('a crashed shell with a stale config endpoint cannot leave the pet hidden', await ev('getComputedStyle(document.querySelector(".dshp-root")).display !== "none" && !!DSHPet.inputSnapshot()'))
  // Load the real desktop renderer with a recording bridge in an isolated browser profile.
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__DSHPET_SHELL__=true;
    window.__bridgeMessages=[];window.__snapshots=0;window.__sayCalls=0;
    window.webkit={messageHandlers:{dshpetshell:{postMessage:(message)=>window.__bridgeMessages.push(message)}}};
    window.dshPetNative={
      input:(s)=>{window.__snapshots++;window.__lastSnapshot=s},hover:()=>{},dragStart:()=>window.__bridgeMessages.push('drag'),dragMove:()=>window.__bridgeMessages.push('move'),dragEnd:()=>{},
      focusInput:(on,activate)=>window.__bridgeMessages.push({focus:on,activate}),
      composition:(on)=>window.__bridgeMessages.push({composition:on}),
      onCursor:()=>{},onVisibility:(fn)=>window.__deliverVisibility=fn,traceInput:()=>{}
    };
    const realFetch=window.fetch;
    window.fetch=(url,options)=>{
      if(String(url).endsWith('/say')){window.__sayCalls++;return Promise.resolve(new Response('{"ok":false,"error":"test-only"}',{headers:{'Content-Type':'application/json'}}))}
      return realFetch(url,options);
    };
  ` })
  await send('Page.navigate', { url: host.petBase + '/dsh-pet/app' })
  await waitFor('!!window.DSHPet && !!DSHPet.inputSnapshot() && !!window.__deliverVisibility')
  await ev(`window.__bridgeMessages=[];DSHPet.setHidden(true);DSHPet.setHidden(true);window.__deliverVisibility(false)`)
  check('page hide emits exactly one request and native acknowledgement emits none', await ev(`window.__bridgeMessages.filter(m=>m==='hidden').length===1 && document.querySelector('.dshp-root').classList.contains('dshp-hidden')`))
  await waitFor('window.__lastSnapshot.collapsed===true && window.__lastSnapshot.panels.length===1')
  check('collapsed desktop retains a visible accessible 大肥鱼 tab and no model hit region', await ev(`document.querySelector('.dshp-tab').textContent.includes('大肥鱼') && getComputedStyle(document.querySelector('.dshp-tab')).display==='flex' && getComputedStyle(document.querySelector('.dshp-stage')).visibility==='hidden' && window.__lastSnapshot.panels[0].w>0`))
  const recoveryPoint = await ev(`(()=>{const r=document.querySelector('.dshp-tab').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...recoveryPoint, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: recoveryPoint.x + 10, y: recoveryPoint.y + 10, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: recoveryPoint.x + 10, y: recoveryPoint.y + 10, button: 'left', buttons: 0, clickCount: 1 })
  check('dragging recovery tab starts native drag and suppresses synthesized expansion click', await ev(`window.__bridgeMessages.includes('drag') && !window.__bridgeMessages.includes('shown') && document.body.classList.contains('dshp-pet-hidden')`))
  await ev(`document.querySelector('.dshp-tab').click()`)
  check('clicking the recovery tab requests expansion once', await ev(`window.__bridgeMessages.filter(m=>m==='shown').length===1`))
  await ev(`window.__bridgeMessages=window.__bridgeMessages.filter(m=>m!=='shown')`)
  const reported = await ev('window.__snapshots')
  await ev('window.__deliverVisibility(true)')
  await waitFor('!document.querySelector(".dshp-root").classList.contains("dshp-hidden")')
  check('restore reports a fresh mask without a shown/hide acknowledgement loop', await ev(`window.__snapshots>${reported} && window.__bridgeMessages.filter(m=>m==='shown').length===0`))
  await ev(`document.querySelector('.dshp-dock button').click()`)
  await waitFor('document.activeElement.tagName === "TEXTAREA"')
  await send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
  check('real browser composition reaches the desktop input bridge', await ev(`window.__bridgeMessages.some(m=>m && m.composition===true)`))
  await send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  check('confirming a Chinese composition cannot submit the draft', await ev('window.__sayCalls===0'))
  await send('Input.insertText', { text: '你好' })
  await waitFor(`window.__bridgeMessages.some(m=>m && m.composition===false)`)
  check('Chinese draft is committed intact', await ev(`document.querySelector('textarea').value==='你好'`))
  await send('Input.insertText', { text: ' world' })
  check('subsequent typing appends without losing previous characters', await ev(`document.querySelector('textarea').value==='你好 world'`))
  await ev(`document.querySelector('.dshp-composer .dshp-close').click()`)
  await sleep(60)
  check('closing the composer releases DOM focus and input mode', await ev(`document.activeElement.tagName!=='TEXTAREA' && window.__bridgeMessages.filter(m=>m && typeof m==='object' && 'focus' in m).at(-1).focus===false`))
  const bodyPoint = await ev(`(()=>{const s=DSHPet.inputSnapshot();const m=s.mask;let n=0,best=Infinity;for(let i=0;i<m.grid.length;i++){if(!m.grid[i])continue;const q=(i%m.w-m.w/2)**2+(Math.floor(i/m.w)-m.h/2)**2;if(q<best){best=q;n=i}}return{x:s.body.x+(n%m.w+.5)*s.body.w/m.w,y:s.body.y+(Math.floor(n/m.w)+.5)*s.body.h/m.h}})()`)
  await ev(`window.__desktopActions=[];window.__originalDesktopClick=DSHPet.desktopClick;DSHPet.desktopClick=(x,y,double)=>{window.__desktopActions.push(double?'talk':'poke');return window.__originalDesktopClick(x,y,double)}`)
  const clickBody = async () => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...bodyPoint, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...bodyPoint, button: 'left', buttons: 0, clickCount: 1 })
  }
  await clickBody()
  check('desktop single click invokes a real reaction and bubble', await ev(`window.__desktopActions.at(-1)==='poke' && DSHPet.state.overrideLeft>0 && document.querySelector('.dshp-bubble').classList.contains('dshp-on')`))
  await sleep(550)
  await clickBody(); await clickBody()
  await waitFor(`document.querySelector('.dshp-composer').classList.contains('dshp-on') && document.activeElement.tagName==='TEXTAREA'`)
  check('desktop double click opens dialogue without a second poke', await ev(`window.__desktopActions.slice(-2).join(',')==='poke,talk'`))
  await ev(`document.querySelector('.dshp-composer .dshp-close').click()`)
  const actionsBeforeDrag = await ev('window.__desktopActions.length')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...bodyPoint, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bodyPoint.x + 15, y: bodyPoint.y + 15, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bodyPoint.x + 15, y: bodyPoint.y + 15, button: 'left', buttons: 0, clickCount: 1 })
  check('dragging a body cannot poke or open dialogue', await ev(`window.__desktopActions.length===${actionsBeforeDrag} && window.__bridgeMessages.includes('move')`))
  await ev(`document.querySelector('.dshp-dock button:nth-child(2)').click();Array.from(document.querySelectorAll('.dshp-tabs button')).find(b=>b.textContent==='设置').click()`)
  const setHeight = async (height) => {
    await ev(`(()=>{const r=document.querySelector('.dshp-label input[type=range]');r.value=${height};r.dispatchEvent(new Event('input',{bubbles:true}));r.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await sleep(250)
    return ev('DSHPet.state.view')
  }
  const small = await setHeight(150), large = await setHeight(280), smallAgain = await setHeight(150)
  check('size control enlarges the model within the desktop size limit', large.w > small.w * 1.5)
  check('size control can shrink back to the same dimensions', smallAgain.w === small.w && smallAgain.h === small.h)
  check('desktop canvas stays fixed while CSS display size changes', await ev(`document.querySelector('canvas').width===${small.render.w}*devicePixelRatio && DSHPet.state.view.render.w===${large.render.w} && DSHPet.state.view.render.h===${large.render.h}`))
  check('settings remain inside viewport after repeated size changes', await ev(`(()=>{const r=document.querySelector('.dshp-menu').getBoundingClientRect();return r.x>=8&&r.y>=8&&r.right<=innerWidth-8&&r.bottom<=innerHeight-8})()`))
  check('size settings expose a 150–280 range and cap large requests', await ev(`(()=>{const r=document.querySelector('.dshp-label input[type=range]');r.value=720;r.dispatchEvent(new Event('input',{bubbles:true}));return r.min==='150'&&r.max==='280'&&r.value==='280'&&DSHPet.state.view.w<=384&&DSHPet.state.view.h<=336})()`))
  check('rapid enlarge/shrink never exposes an empty backing frame', await ev(`(()=>{const r=document.querySelector('.dshp-label input[type=range]');for(const h of [150,180,240,280,220,150,280,150]){r.value=h;r.dispatchEvent(new Event('input',{bubbles:true}));if(!DSHPet.sampleCanvas(24).some((v,i)=>i%4===3&&v>8))return false}return true})()`))
  console.log('结果：pass ' + pass + ' / fail 0')
} finally {
  if (ws) ws.close()
  owner.close(); host.close()
  child.kill()
  await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 2000) } })
  // Chromium descendants may briefly retain files on Windows; preserve temp if still locked.
  try { fs.rmSync(temp, { recursive: true, force: true }) } catch {}
}
