// GENERATED: edit tools/shell-gen/templates/preload.cjs and run node tools/shell-gen/make-standalone-shell.mjs
'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__DSHPET_SHELL__', true)
contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: { dshpetshell: { postMessage: (msg) => ipcRenderer.send('shell-msg', String(msg)) } },
})
contextBridge.exposeInMainWorld('dshPetNative', {
  input: (snapshot) => ipcRenderer.send('pet-input', snapshot),
  hover: (point) => ipcRenderer.send('pet-hover', point),
  dragStart: (point) => ipcRenderer.send('drag-start', point),
  dragMove: (delta) => ipcRenderer.send('drag-move', delta),
  dragEnd: (delta) => ipcRenderer.send('drag-end', delta),
  focusInput: (on, activate = false) => ipcRenderer.send('pet-focus', { on: !!on, activate: !!activate }),
  composition: (on) => ipcRenderer.send('pet-composition', !!on),
  onVisibility: (fn) => ipcRenderer.on('pet-visibility', (_event, visible) => fn(visible)),
  ready: (state) => ipcRenderer.send('pet-ready', state),
  requestRecovery: (reason) => ipcRenderer.send('pet-recover', String(reason)),
  onRecovery: (fn) => ipcRenderer.on('pet-recovery', (_event, state) => fn(state)),
  onSuspend: (fn) => ipcRenderer.on('pet-suspend', () => fn()),
  onCursor: (fn) => ipcRenderer.on('pet-cursor', (_event, point) => fn(point)),
  diagnostics: () => ipcRenderer.invoke('pet-diagnostics'),
  traceInput: (point) => ipcRenderer.send('pet-trace', point),
})
