import { fileURLToPath } from 'node:url'
// 从 lib/media-bridge.mjs 生成 desktop/standalone/media-bridge.cjs（CommonJS 版，给壳用）。
// 为什么：Electron 33 的 ESM 加载器处理内置模块 electron 时会崩
//（cjsPreparseModuleExports: Cannot read properties of undefined），所以壳必须走 CommonJS。
// 而 lib/media-bridge.mjs 是 ESM（宿主在用）。与其维护两份实现，不如**生成**这一份，
// 并在 CI/测试里对账（test-shell-server.mjs 会验壳这份能真读会话）。
// 只做机械改写：import → require，export → module.exports。逻辑一行不动。
/**
 * 仓库根定位：这个脚本放在 tools/shell-gen/ 下，
 * 往上退两级就是仓库根。不写死绝对路径 —— 否则别人 clone 下来跑不了。
 *
 * 历史：这几个生成器原来只存在于作者机器的 D:\Bigfish\_staging\（**不在仓库里**），
 * 而 main.js / preload.js / *.cjs 都是它们生成的产物 —— 于是 clone 下来的人
 * 拿到的是一堆"改了会被覆盖、却找不到生成器"的生成物。所以搬进仓库。
 */
const REPO = (() => {
  const cand = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const marker = path.join(cand, 'desktop', 'standalone')
  if (!fs.existsSync(marker)) {
    throw new Error('找不到仓库根：期望 ' + marker + ' 存在（脚本应放在 tools/shell-gen/ 下）')
  }
  return cand
})()
import path from 'node:path'

import fs from 'node:fs'

const SRC = path.join(REPO, 'lib', 'media-bridge.mjs')
const OUT = path.join(REPO, 'desktop', 'standalone', 'media-bridge.cjs')
let s = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')

const before = s
s = s.replace(
  /^import path from 'node:path'\nimport \{ spawn \} from 'node:child_process'\nimport \{ fileURLToPath \} from 'node:url'\n/m,
  `'use strict'
// ⚠️ 本文件是**生成物**（由 lib/media-bridge.mjs 机械转换而来，见 tools 里的说明）。
// 别直接改它 —— 要改逻辑请改 lib/media-bridge.mjs，然后重新生成：
//   见仓库 tools/shell-gen/make-shell-cjs-bridge.mjs（由它生成）
const path = require('node:path')
const { spawn } = require('node:child_process')
`,
)
if (s === before) throw new Error('import 段没替换成功（源文件结构变了？）')

// ESM 里用 import.meta.url 求目录；CJS 里用 __dirname
s = s.replace(/const HERE = path\.dirname\(fileURLToPath\(import\.meta\.url\)\)\n/, '')
s = s.replace(/export const SMTC_HELPER = path\.join\(HERE, 'smtc-helper\.ps1'\)/, "const SMTC_HELPER = path.join(__dirname, '..', '..', 'lib', 'smtc-helper.ps1')")
s = s.replace(/export const MEDIA_CMDS/, 'const MEDIA_CMDS')
s = s.replace(/export const MEDIA_APP_RE/, 'const MEDIA_APP_RE')
s = s.replace(/export function mediaReason/, 'function mediaReason')
s = s.replace(/export function createMediaBridge/, 'function createMediaBridge')
s += `
module.exports = { createMediaBridge, mediaReason, MEDIA_CMDS, MEDIA_APP_RE, SMTC_HELPER }
`
fs.writeFileSync(OUT, s, 'utf8')
console.log('写出 ' + OUT + '（' + s.split('\n').length + ' 行）')
console.log('还残留 ESM 语法吗: ' + /^(import|export)\s/m.test(s))
