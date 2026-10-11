// ============================================================================
// test-skill-music.mjs —— 校验 skill/whale-song-music.md 没写错、也没过期
// ----------------------------------------------------------------------------
// 为什么值得单独测：这份 skill 是**给 agent 看的操作手册** —— 里面写了"用哪条命令点播"。
// 命令一旦改名/搬家（例如 dsh-netease 的 CLI 挪进本仓库），skill 会静默变成错的，
// 而 agent 会照着错的去做（用户看到的就是"她点歌失败了"）。所以这里把文档里出现的
// 每条 CLI 子命令拿去和真 CLI 的 --help 对账，并把宿主路由拿去和真插件注册的路由对账。
//
// 跑：node tools/test-skill-music.mjs
// 没有那套 CLI（别的机器）时：本地命令那部分会跳过并说明，不算失败。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const SKILL = path.join(ROOT, 'skill', 'whale-song-music.md')
const CLI = process.env.DSHW_NETEASE_CLI || 'D:\\Plugins\\dsh-netease\\netease-cli.mjs'

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  ok   ' + msg) }
  else { fail++; failures.push(msg); console.log('  FAIL ' + msg + (detail === undefined ? '' : '  → ' + detail)) }
}
function skip(msg) { console.log('  skip ' + msg) }

console.log('\n--- skill 文件本身 ---')
ok(fs.existsSync(SKILL), 'skill/whale-song-music.md 存在', SKILL)
const text = fs.readFileSync(SKILL, 'utf8')
ok(/^---\n[\s\S]*?name:\s*whale-song-music[\s\S]*?\n---\n/.test(text), '有 frontmatter 且 name 合规（skill 靠它被发现）', '')
ok(/description:\s*[^\n]{40,}/.test(text), 'description 够长（触发词写得清，agent 才找得到它）',
  (/description:\s*([^\n]*)/.exec(text) || [])[1])
for (const kw of ['放首歌', '点一首', '切下一首', '暂停', '现在在放什么']) {
  if (text.indexOf(kw) < 0) ok(false, 'description 覆盖触发词「' + kw + '」', '')
}
ok(['放首歌', '点一首', '切下一首', '暂停', '现在在放什么'].every((k) => text.indexOf(k) >= 0),
  'description 覆盖常见触发词', '')
ok(/CC BY-NC-SA|非商业/.test(text), '写明了许可红线（非商业）', '')
ok(/不解码|不做"免费听 VIP"|不碰账号/.test(text), '写明了不绕版权的边界', '')

console.log('\n--- 文档里引用的 CLI 子命令是否真的存在 ---')
if (!fs.existsSync(CLI)) {
  skip('这台机器没有 ' + CLI + '（跳过 CLI 对账；skill 里那部分命令没法验）')
} else {
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
  const helpText = String(help.stdout || '') + String(help.stderr || '')
  // 从 skill 里抠出 `netease-cli.mjs <子命令>` 的所有用法
  const used = new Set()
  const re = /netease-cli\.mjs\s+(--?[a-z-]+|[a-z][a-z-]*)/g
  let m
  while ((m = re.exec(text))) {
    const sub = m[1]
    if (sub.startsWith('--')) continue   // 选项（--id/--list）单独看
    used.add(sub)
  }
  const subs = [...used].sort()
  ok(subs.length >= 6, 'skill 里引用了 ' + subs.length + ' 个 CLI 子命令', subs.join(','))
  for (const sub of subs) {
    // --help 里每行形如 `node netease-cli.mjs <sub> ...`；用词边界匹配避免 search 命中 search-x
    const known = new RegExp('netease-cli\\.mjs\\s+[^\\n]*\\b' + sub + '\\b').test(helpText)
    if (!known) ok(false, 'CLI 认识子命令「' + sub + '」', 'skill 写了但 --help 里没有 —— 文档过期了')
  }
  ok(subs.every((sub) => new RegExp('netease-cli\\.mjs\\s+[^\\n]*\\b' + sub + '\\b').test(helpText)),
    'skill 里所有子命令 CLI 都认识（' + subs.join(', ') + '）', '')
  // --id / --list 选项
  for (const opt of ['--id', '--list']) {
    if (text.indexOf(opt) >= 0) {
      if (helpText.indexOf(opt) < 0) ok(false, 'CLI 支持选项「' + opt + '」', 'skill 写了但 --help 里没有')
    }
  }
  ok(helpText.indexOf('--id') >= 0 && helpText.indexOf('--list') >= 0, 'skill 里的 --id / --list 选项 CLI 都支持', '')
}

console.log('\n--- 文档里写的宿主路由是否真的注册 ---')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-skill-'))
  process.env.DSH_HOME = tmp
  const routes = []
  const ctx = {
    webServer: { port: 1, register(r) { routes.push(r); return () => {} }, tapIndex() { return () => {} } },
    connection: undefined,
    effect(fn) { return fn() },
    get() { return undefined },
    on() {},
    logger: console,
  }
  const plugin = (await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)).default
  plugin.apply(ctx)
  const paths = routes.map((r) => r.path)
  // skill 里出现的宿主路由：以 /dsh- 开头（宽松匹配，避免被反引号/表格语法绕过去）
  const mentioned = new Set()
  const rre = /\/dsh-[a-z0-9-]+\/[a-z0-9._/-]+/g
  let mm
  while ((mm = rre.exec(text))) mentioned.add(mm[0])
  const list = [...mentioned].sort()
  ok(list.length >= 4, 'skill 里提到了 ' + list.length + ' 条宿主路由', list.join(', '))
  for (const p of list) {
    const known = paths.indexOf(p) >= 0
    if (!known) ok(false, '宿主真的注册了「' + p + '」', 'skill 写了但插件没这条路由 —— 文档过期了')
  }
  ok(list.every((p) => paths.indexOf(p) >= 0), 'skill 里所有宿主路由都真实存在', '')
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (err) {}
}

console.log('\n--- 不该出现的东西（避免把内部/敏感信息写进给 agent 的文档）---')
ok(text.indexOf('C:\\Users\\') < 0 && text.indexOf('C:/Users/') < 0, '没有写死用户主目录路径', '')
ok(!/token|cookie\s*=|api[_-]?key/i.test(text.replace(/不碰账号 cookie|账号 cookie|不解码/g, '')), '没有引导去读凭据', '')

console.log('\n结果：pass ' + pass + ' / fail ' + fail)
if (fail && failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail ? 1 : 0)
