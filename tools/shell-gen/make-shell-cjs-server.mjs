// 从 desktop/standalone/server.mjs 生成 CommonJS 版 server.cjs（Electron 33 的 ESM 加载器
// 处理内置模块 electron 时会崩，所以壳一律走 CJS；逻辑一行不改，只做机械改写）。
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
import { fileURLToPath } from 'node:url'

import fs from 'node:fs'

const SRC = path.join(REPO, 'desktop', 'standalone', 'server.mjs')
const OUT = path.join(REPO, 'desktop', 'standalone', 'server.cjs')
let s = fs.readFileSync(SRC, 'utf8')
const before = s

s = s.replace(
  /^import fs from 'node:fs'\nimport http from 'node:http'\nimport path from 'node:path'\nimport \{ createMediaBridge, mediaReason, MEDIA_APP_RE \} from '\.\.\/\.\.\/lib\/media-bridge\.mjs'\n/m,
  `'use strict'
// ⚠️ 生成物：由 desktop/standalone/server.mjs 机械转换而来（理由见那边文件头注释）。
// 要改逻辑请改 .mjs，然后重新生成：node tools/shell-gen/make-shell-cjs-server.mjs
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { createMediaBridge, mediaReason, MEDIA_APP_RE } = require('./media-bridge.cjs')
`,
)
if (s === before) throw new Error('import 段没替换成功')

s = s.replace(/export function resolveRepoRoot/, 'function resolveRepoRoot')
s = s.replace(/export function startPetServer/, 'function startPetServer')
// ESM 里用 import.meta.url 推目录；CJS 直接用 __dirname（desktop/standalone → 仓库根）
s = s.replace(
  /\s*path\.resolve\(path\.dirname\(new URL\(import\.meta\.url\)\.pathname\.replace\(\/\^\\\/\(\[A-Za-z\]:\)\/, '\$1'\)\), '\.\.', '\.\.'\),/,
  "\n    path.resolve(__dirname, '..', '..'),",
)
if (/import\.meta\.url/.test(s)) throw new Error('还有 import.meta.url 没换掉')
s += `
module.exports = { startPetServer, resolveRepoRoot }
`
fs.writeFileSync(OUT, s, 'utf8')
console.log('写出 ' + OUT + '（' + s.split('\n').length + ' 行）')
console.log('残留 ESM 语法吗: ' + /^(import|export)\s/m.test(s))
