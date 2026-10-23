import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
let installed
try { installed = require('electron') } catch {}
const electron = [installed, path.join(os.homedir(), '.dsh/electron/electron.exe')]
  .find(p => typeof p === 'string' && fs.existsSync(p))
if (!electron) throw new Error('找不到 Electron。请先在本目录运行 npm install。')
const env = { ...process.env, WHALESONG_PREVIEW: process.argv.includes('--activate') ? '0' : '1' }
delete env.ELECTRON_RUN_AS_NODE
const args = [path.join(root, 'desktop/standalone')]
if (process.argv.includes('--debug')) args.push('--remote-debugging-port=9338')
const child = spawn(electron, args, {
  cwd: root, env, detached: true, windowsHide: true, stdio: 'ignore'
})
child.on('error', e => { console.error(e.message); process.exitCode = 1 }); child.unref()
console.log(env.WHALESONG_PREVIEW === '1' ? '鲸歌新版预览已启动；旧桌宠配置保持原样。' : '鲸歌正式模式已启动。')
