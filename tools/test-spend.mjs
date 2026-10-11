// ============================================================================
// test-spend.mjs —— 「花费额度提示」的累计与清零语义（毫秒级，不需要浏览器）
// 从 assets/pet.js 抠出增量⑥那一块，塞进 vm，用桩 HUD 驱动，断言：
//   未到额度不响 / 累计到额度响一次并清零 / 同一轮不重复计 / 清零后重新累计 /
//   单轮超额度立刻响 / 关掉开关完全不响。
// 跑：node tools/test-spend.mjs
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '..', 'assets', 'pet.js'), 'utf8')
const startMark = '// —— 鲸歌增量 ⑥：花费额度提示 ——'
const a = src.indexOf(startMark)
const b = src.indexOf('setInterval(dshwSongSpendTick, 5000)', a)
if (a < 0 || b < 0) throw new Error('在 pet.js 里找不到增量⑥（标记被改动过？）')
const block = src.slice(a, src.indexOf('\n', b))

let bad = 0
const ok = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (c ? '' : '  → ' + d)); if (!c) bad++ }

function make(over) {
  const bubbles = []
  const CFG = Object.assign({ songSpendAlert: true, songSpendThreshold: 0.5 }, over || {})
  const hud = { turn: { seq: 0, amount: 0, currency: 'CNY' }, balance: 12.34 }
  const ctx = { CFG, hud, ui: { bubble: { show: (m) => bubbles.push(m) } }, console, setInterval: () => 0 }
  vm.createContext(ctx)
  vm.runInContext(block + '\n;globalThis.__t = dshwSongSpendTick;', ctx)
  return { ctx, hud, CFG, bubbles, tick: () => ctx.__t() }
}

// 1) 未到额度
let e = make()
e.hud.turn = { seq: 1, amount: 0.3, currency: 'CNY' }
e.tick()
ok(e.bubbles.length === 0, '单轮 0.3 元（未到 0.5）不响', '' + e.bubbles.length)

// 2) 累计到额度 → 响一次并清零
e.hud.turn = { seq: 2, amount: 0.3, currency: 'CNY' }
e.tick()
ok(e.bubbles.length === 1 && /花了 ¥0\.60/.test(e.bubbles[0]) && /余额 ¥12\.34/.test(e.bubbles[0]),
  '累计到 0.6 → 冒一次「这几轮花了 ¥0.60 · 余额 ¥12.34」', e.bubbles[0])

// 3) 同一轮重复 tick 不重复计
e.tick()
ok(e.bubbles.length === 1, '同一轮重复 tick 不重复计', '' + e.bubbles.length)

// 4) 清零后重新累计：0.3 不响
e.hud.turn = { seq: 3, amount: 0.3, currency: 'CNY' }
e.tick()
ok(e.bubbles.length === 1, '清零后重新累计：再来 0.3 不响', '' + e.bubbles.length)

// 5) 单轮超额度 → 立刻响（此时累计 0.3 + 1.2 = 1.5）
e.hud.turn = { seq: 4, amount: 1.2, currency: 'CNY' }
e.tick()
ok(e.bubbles.length === 2 && /花了 ¥1\.50/.test(e.bubbles[1]), '单轮超额度 → 立刻响且金额为累计值', e.bubbles[1])

// 6) 关掉开关
const off = make({ songSpendAlert: false })
off.hud.turn = { seq: 1, amount: 5, currency: 'CNY' }
off.tick()
ok(off.bubbles.length === 0, '开关关闭后完全不响', '' + off.bubbles.length)

// 7) 阈值为 0 / 非法 → 视为关闭，不响
const zero = make({ songSpendThreshold: 0 })
zero.hud.turn = { seq: 1, amount: 5, currency: 'CNY' }
zero.tick()
ok(zero.bubbles.length === 0, '阈值为 0 视为关闭（不响）', '' + zero.bubbles.length)

console.log(bad ? '\n结果：失败 ' + bad + ' 项' : '\n结果：全部通过')
process.exit(bad ? 1 : 0)
