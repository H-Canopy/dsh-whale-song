#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
let electron
try { electron = require('electron') } catch {}
if (typeof electron !== 'string' || !fs.existsSync(electron)) {
  console.error('Electron is missing. Run npm install in the repository, then npm run desktop:start.')
  process.exit(1)
}
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [path.join(root, 'desktop', 'standalone')], {
  cwd: root, env, detached: true, windowsHide: true, stdio: 'ignore',
})
child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
child.unref()
