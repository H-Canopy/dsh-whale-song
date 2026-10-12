// ============================================================================
// test-all.mjs —— 一趟跑完全部"快速测试"（毫秒~秒级，不需要浏览器/真机放歌）
// ----------------------------------------------------------------------------
// 为什么要有它：fork 的增量测试散成好几个文件，逐个敲容易漏。这里统一跑一遍并按名字汇总，
// 任何一项失败都让退出码非 0（可直接当发布前的闸门）。
//   · 每个子测试都用**同一个 node**（process.execPath）跑，避免 PATH 里没有 node 的机器上炸
//   · --live 会额外把打真机 SMTC 的那部分带上（只读，不动播放状态）
//
// 跑：node tools/test-all.mjs [--live]
// ============================================================================
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIVE = process.argv.includes('--live')

// 顺序：宿主路由 → 统一层前端 → 媒体桥 → 页签 → 本地音乐/电台服务 → 偏好/花费 → 音源适配器
const SUITES = [
  ['宿主路由 /dsh-pet/media', 'test-media-route.mjs'],
  ['统一层前端 media-smtc', 'test-media-smtc.mjs'],
  ['媒体桥 media-bridge', 'test-media-bridge.mjs'],
  ['「音乐」页签', 'test-music-pane.mjs'],
  ['本地音乐前端', 'test-media-local.mjs'],
  ['本地音乐/电台服务', 'test-media-services.mjs'],
  ['偏好与简报', 'test-prefs.mjs'],
  ['花费额度提示', 'test-spend.mjs'],
  ['音源适配器', 'test-sources.mjs'],
  ['音乐 skill 文档', 'test-skill-music.mjs'],
  ['单机模式（无后端）', 'test-standalone.mjs'],
  ['独立壳的本地服务', 'test-shell-server.mjs'],
  ['独立壳的窗口逻辑', 'test-shell-window.mjs'],
  ['右键双击音乐（统一层接线）', 'test-rightclick-media.mjs'],
  ['不依赖挂件', 'test-no-widget-required.mjs'],
]

const results = []
for (const [label, file] of SUITES) {
  const args = [path.join(HERE, file)]
  if (LIVE && file === 'test-media-route.mjs') args.push('--live')
  process.stdout.write(`\n=== ${label}（${file}${LIVE && file === 'test-media-route.mjs' ? ' --live' : ''}）\n`)
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' })
  const out = String(r.stdout || '') + String(r.stderr || '')
  const last = out.trim().split(/\r?\n/).filter((l) => /结果|pass \d+ \/ fail|失败/.test(l)).pop() || ''
  process.stdout.write(out.split(/\r?\n/).filter((l) => /^\s*(FAIL|失败项)/.test(l)).join('\n') + (out.match(/FAIL/) ? '\n' : ''))
  const okRun = r.status === 0
  results.push({ label, file, ok: okRun, summary: last.trim() || ('exit ' + r.status) })
}

console.log('\n================ 汇总 ================')
let bad = 0
for (const r of results) {
  if (!r.ok) bad++
  console.log((r.ok ? '  ok   ' : '  FAIL ') + r.label.padEnd(22, ' ') + r.summary)
}
console.log(bad ? `\n结论：${bad} 组测试未通过` : `\n结论：${results.length} 组测试全部通过`)
process.exit(bad ? 1 : 0)
