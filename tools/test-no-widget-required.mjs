// ============================================================================
// test-no-widget-required.mjs —— 锁住「不需要再装挂件 dsh-whale-widget 」
// ----------------------------------------------------------------------------
// 产品要求（主人原话）："以后再也不需要挂件了对吧，毕竟我们不能要求其他用户再下一个挂件"。
// 这条要求靠"我改完了"是保不住的 —— 下次加功能很容易又顺手引一个挂件接口。
// 所以这里把它变成**可执行的规则**：
//   ① 我们自己必须提供那两条能力（宿主路由 /dsh-pet/hud 与 /dsh-pet/media；前端 window.dshwSongSMTC）
//   ② 凡是用到挂件接口的地方，**必须是"我们优先、挂件兜底"**，不能反过来
//   ③ 不能出现"挂件不在就啥也不发生"的死按钮
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  ok   ' + msg) }
  else { fail++; failures.push(msg); console.log('  FAIL ' + msg + (detail === undefined ? '' : '  → ' + detail)) }
}

const host = read('lib/index.js')
const pet = read('assets/pet.js')
const bridge = read('assets/media-bridge.js')
const smtc = read('assets/media-smtc.js')

console.log('\n--- ① 自己的能力必须齐（这是"不需要挂件"的前提）---')
ok(/route\('exact', '\/dsh-pet\/hud'/.test(host) || /'\/dsh-pet\/hud'/.test(host), '宿主自带钱包接口 /dsh-pet/hud（余额/峰谷/本轮）', '')
ok(/\/dsh-pet\/media/.test(host), '宿主自带媒体会话接口 /dsh-pet/media', '')
ok(/window\.dshwSongSMTC\s*=/.test(smtc), '前端自带统一层 window.dshwSongSMTC', '')
ok(/dshwSongSMTC/.test(pet), '桌宠前端会用它', '')

console.log('\n--- ② 钱包：我们优先，挂件只做兜底 ---')
{
  const i = pet.indexOf('async function hudFetch')
  const seg = pet.slice(i, i + 3000)
  const selfAt = seg.indexOf('HUD_SELF')
  const widgetAt = seg.indexOf('HUD_SRC.balance')
  ok(selfAt >= 0 && widgetAt > selfAt, '先问自己（HUD_SELF）再退回挂件（HUD_SRC）', 'self@' + selfAt + ' widget@' + widgetAt)
  ok(/hud\.source = 'self'/.test(seg), '自己那份标记为 source=self（可对账）', '')
}

console.log('\n--- ③ 媒体：统一层优先，挂件兜底，两个都没有要返回 null（不能假装成功）---')
{
  const i = bridge.indexOf('function')
  ok(bridge.indexOf('dshwSongSMTC.now()') >= 0 || /dshwSongSMTC/.test(bridge), '媒体桥首选统一层', '')
  const ti = pet.indexOf('function dshwSongToggleAny')
  const seg = pet.slice(ti, ti + 700)
  ok(seg.indexOf('dshwSongSMTC') >= 0 && seg.indexOf('dshwMediaCtl') > seg.indexOf('dshwSongSMTC'),
    '控制接口也是统一层优先、挂件在后', '')
  ok(/return null/.test(seg), '两个都没有时返回 null（调用方给"没检测到播放器"的提示）', '')
}

console.log('\n--- ④ 不允许存在"挂件不在就什么都不发生"的死按钮 ---')
{
  // 只看**代码**，不看注释：注释里会提到这个名字（说明为什么删掉），那是好事。
  const code = pet
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  ok(!/打开挂件面板/.test(code), '「🎵 打开挂件面板」按钮已彻底删除（代码里不再出现）', '')
  ok(!/open-panel/.test(code), '也没有残留的 open-panel 命令派发', '')
  // 允许出现挂件接口名，但**不允许**把它写进"显示/隐藏某个按钮"的条件里
  const guard = /if \(typeof window !== 'undefined'\s*&& \(typeof window\.dshwMedia(Now|Ctl) === 'function'/.test(code)
  ok(!guard, '没有"用挂件接口是否存在来决定按钮显不显示"的写法', '')
}

console.log('\n--- ⑤ 明确记录：挂件是可选加速项，不是前置 ---')
{
  const okNote = /挂件/.test(host) && /(可选|兜底|装了|降级)/.test(host)
  ok(okNote, '宿主注释里写清了"挂件可选"（免得后人又当它是依赖）', '')
}

console.log('\n结果：pass ' + pass + ' / fail ' + fail)
if (fail && failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail ? 1 : 0)
