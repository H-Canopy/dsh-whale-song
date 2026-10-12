// 从 desktop/standalone/window-shape.mjs 生成 CommonJS 版 window-shape.cjs（壳用）。
// 理由同 server.cjs / media-bridge.cjs：Electron 33 的 ESM 加载器处理内置模块 electron 会崩，
// 所以壳一律走 CommonJS。**只做机械改写，逻辑一行不改** —— 包括诊断代码也必须写在 .mjs 里。
//
// 教训（已还的架构债）：以前 maskBbox 诊断是在这里注入的，于是 .cjs 有、.mjs 没有；
// 而外部评审是手改这两个文件的，结果一次重新生成就会把诊断丢掉。现在源头只有 .mjs。
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

const SRC = path.join(REPO, 'desktop', 'standalone', 'window-shape.mjs')
const OUT = path.join(REPO, 'desktop', 'standalone', 'window-shape.cjs')
let s = fs.readFileSync(SRC, 'utf8')
const before = s

// 按**行**替换 import 段（不用正则，避免行尾/空行差异把替换搞失败）
{
  const nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const L = s.split(/\r?\n/)
  const first = L.findIndex((l) => l === "import fs from 'node:fs'")
  if (first < 0) throw new Error('找不到 import 段起点')
  const last = L.findIndex((l) => l === "import { spawn } from 'node:child_process'")
  if (last < 0 || last < first) throw new Error('找不到 import 段终点')
  L.splice(first, last - first + 1,
    "'use strict'",
    '// ⚠️ 生成物：由 window-shape.mjs 机械转换而来（理由见那个文件头）。',
    '// 要改逻辑请改 .mjs，然后重新生成：node tools/shell-gen/make-shell-cjs-shape.mjs',
    "const fs = require('node:fs')",
    "const os = require('node:os')",
    "const path = require('node:path')",
    "const { spawn } = require('node:child_process')",
  )
  s = L.join(nl)
}
if (s === before) throw new Error('import 段没替换成功（源文件结构变了？）')

s = s.replace(/export function createShaper/, 'function createShaper')
if (/^export\s/m.test(s)) throw new Error('还有 export 没换掉')
// 机械生成的自检：源头该有的东西，产物也必须有（防止"只改了 .cjs 忘了 .mjs"）
for (const [pat, name] of [
  [/maskBbox 诊断/, 'maskBbox 诊断'],
  [/minGapMs/, '限频 minGapMs'],
  [/b\.length, h\]/, '内容哈希 keyOf'],
  [/\$pad = \[int\]\$args\[8\]/, 'PS 侧 pad 参数'],
]) {
  if (!pat.test(s)) throw new Error(name + ' 不在产物里（源头 .mjs 少写了？）')
}
s += `
module.exports = { createShaper }
`
fs.writeFileSync(OUT, s, 'utf8')
console.log('写出 ' + OUT + '（' + s.split('\n').length + ' 行）')
console.log('残留 ESM 语法: ' + /^(import|export)\s/m.test(s))
