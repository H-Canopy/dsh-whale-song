// ============================================================================
// test-prefs.mjs —— 简报分档与两个开关的语义测试（毫秒级，不需要浏览器）
// 做法：从 assets/pet.js 里抠出"鲸歌增量"那一块，塞进 vm 并替掉 pushReport/CFG 依赖，
// 直接断言三档语义与持久化调用。跑：node tools/test-prefs.mjs
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '..', 'assets', 'pet.js'), 'utf8')
const mk = '【鲸歌 dsh-whale-song 增量 ①】'
const a = src.indexOf(mk)
const b = src.indexOf('try { window.dshwSongPrefs = dshwSongPrefs }', a)
if (a < 0 || b < 0) throw new Error('在 pet.js 里找不到鲸歌增量块（标记被改动过？）')
const block = src.slice(src.lastIndexOf('\n', a) + 1, b)

let bad = 0
const ok = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (c ? '' : '  → ' + d)); if (!c) bad++ }

const pushed = []
let persisted = 0
const ctx = {
  CFG: {}, agent: { tokens: 1234 },
  pushReport: (t, bo) => pushed.push([t, bo]),
  persistCfg: () => persisted++,
  saveLayout() {}, readLayout() { return {} }, console, window: {},
}
vm.createContext(ctx)
vm.runInContext(block + '\n;globalThis.__p=dshwSongPrefs;globalThis.__b=dshwSongBrief;', ctx)
const P = ctx.__p
const B = ctx.__b

ok(P().briefing === 'stats', '默认档 = stats（比她上游安静）', '' + P().briefing)
ok(P().showReports === true && P().innerVoice === true, '另两个开关默认开（不动她原有手感）', JSON.stringify(P()))
B('x'.repeat(80))
ok(pushed.length === 1 && pushed[0][1].indexOf('正文已隐藏') >= 0 && pushed[0][1].indexOf('x'.repeat(20)) < 0,
  'stats：只报一行、不含回复正文', JSON.stringify(pushed[0] && pushed[0][1]))
pushed.length = 0; P({ briefing: 'off' }); B('y'.repeat(80))
ok(pushed.length === 0, 'off：完全不报', '' + pushed.length)
pushed.length = 0; P({ briefing: 'full' }); B('z'.repeat(80))
ok(pushed.length === 1 && pushed[0][1].length === 80, 'full：保持上游行为（报原文）', 'len=' + (pushed[0] && pushed[0][1].length))
pushed.length = 0; P({ showReports: false }); B('w'.repeat(80))
ok(pushed.length === 0, '显示工作简报=关：整体静音', '' + pushed.length)
ok(persisted >= 3, '改动即落盘（走她自己的 persistCfg）', 'persisted=' + persisted)
B('short')
ok(pushed.length === 0, '短回复（<=60 字）不推简报（沿用上游阈值）', '' + pushed.length)

console.log(bad ? '\n结果：失败 ' + bad + ' 项' : '\n结果：全部通过')
process.exit(bad ? 1 : 0)
