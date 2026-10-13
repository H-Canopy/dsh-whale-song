#!/usr/bin/env node
/**
 * publish.mjs —— 一条命令把桌宠发布出去：建仓库 → 推代码 → 给插件市场提 PR。
 *
 *   node tools/publish.mjs --check                 # 只做本地/远端自检，不写任何东西
 *   GITHUB_TOKEN=xxx node tools/publish.mjs        # 真发布（建仓库 + 推送 + 提 PR）
 *   GITHUB_TOKEN=xxx node tools/publish.mjs --no-pr   # 只建仓库 + 推代码，不提市场 PR
 *
 * 为什么要有这个脚本：发布要跨三个系统（本地 git / GitHub / awesome-dsh-plugin 列表），
 * 手点容易漏步骤，而且「市场和 npm 的撞名」这种坑必须自动挡在前面。
 *
 * 需要的 token：**classic token 勾 `public_repo` 就够**（建仓库 / 推送 / fork / 开 PR 都覆盖）。
 *   https://github.com/settings/tokens/new?scopes=public_repo&description=dsh-whale-song
 *
 * 想「以后一直能发新版本」：把 token 存进 macOS 钥匙串一次即可（本脚本会自动读）：
 *   security add-generic-password -a Andersen216 -s dsh-whale-girl-live2d-publish -w
 * 之后更新版本只要两步：改代码 → `npm run release:github`。
 * token 只从环境变量读，不落盘、不写进 git config、不打日志。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
// 工作区路径里有空格（"DSH Workplace"），用 URL.pathname 会拿到 %20 编码的假路径，
// 必须走 fileURLToPath 解回来。
import { fileURLToPath } from 'node:url'

// GitHub 账号：市场卡片上显示的就是它。可以用 --owner=xxx 或 GH_OWNER 环境变量覆盖。
const OWNER = (() => {
  const a = process.argv.find((x) => x.startsWith('--owner='))
  if (a) return a.slice('--owner='.length)
  return process.env.GH_OWNER || 'H-Canopy'
})()
/**
 * 插件名（= package.json 的 name = GitHub 仓库名）。
 *
 * ⚠️ 这里**必须跟 package.json 一致**，而且本增强版 fork 的名字是 `dsh-whale-song`。
 *    上游叫 `dsh-whale-girl-live2d`；这个 fork **故意改名**，好让两边能同时装、互不替换。
 *    所以别照抄上游那份自检里的名字 —— 曾经写死成上游名，导致自检永远报
 *    「名字是 dsh-whale-song，应该是 dsh-whale-girl-live2d」这种假红，
 *    久了两条真问题（LICENSE 缺非商业声明）就被淹在假红里看不见了。
 *    要发到别的名字下：--repo=xxx 或 GH_REPO 环境变量。
 */
const REPO = (() => {
  const a = process.argv.find((x) => x.startsWith('--repo='))
  if (a) return a.slice('--repo='.length)
  return process.env.GH_REPO || 'dsh-whale-song'
})()
const LIST_OWNER = 'awesome-dsh-plugin'
const LIST_REPO = 'awesome-dsh-plugin'
const CATEGORY = 'fun'
const BRANCH = 'main'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 同步睡一会儿（毫秒）。
 * ⚠️ 别用 `execFileSync('sleep', ...)` —— 那是 Unix 命令，Windows 上没有，
 *    会直接抛 `spawnSync sleep ENOENT` 把整个自检弄崩（真踩过：自检跑到"远端撞名检查"
 *    就崩了，看起来像网络问题，其实是缺 sleep）。
 *    Atomics.wait 是标准库、同步、跨平台，不需要任何外部命令。
 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch (e) {}
}
// token 来源优先级：环境变量 → macOS 钥匙串（推荐，钥匙串是加密的，不用明文存）
// 存一次（在你自己终端里跑，会让你手动输入，不会进 shell 历史）：
//   security add-generic-password -a Andersen216 -s dsh-whale-girl-live2d-publish -w
function tokenFromKeychain() {
  if (process.platform !== 'darwin') return ''
  try {
    return execFileSync('security', ['find-generic-password', '-a', 'Andersen216',
      '-s', 'dsh-whale-girl-live2d-publish', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch (e) { return '' }
}
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || tokenFromKeychain()
const CHECK_ONLY = process.argv.includes('--check')
const SKIP_PR = process.argv.includes('--no-pr')

const ok = (m) => console.log('  ✅ ' + m)
const bad = (m) => console.log('  ❌ ' + m)
const info = (m) => console.log('  ·  ' + m)
let problems = 0

function gh(method, url, body) {
  const args = ['-sS', '-X', method, '-H', 'Accept: application/vnd.github+json',
    '-H', `Authorization: Bearer ${TOKEN}`, '-H', 'User-Agent: dsh-publish',
    '-H', 'X-GitHub-Api-Version: 2022-11-28', url]
  if (body) args.push('-d', JSON.stringify(body))
  const out = execFileSync('curl', args, { encoding: 'utf8' })
  try { return JSON.parse(out) } catch (e) { return { raw: out } }
}

/**
 * 取一个 URL 的 HTTP 状态码。网络抖动不当成"名字被占"——重试三次，仍失败返回 'ERR'。
 *
 * ⚠️ 这里**不再用 curl**。原来那版是 Unix-only，有两个坑：
 *    · `-o /dev/null` —— Windows 上没有 /dev/null，curl 写不进去 →
 *      满屏 `curl: (23) client returned ERROR on write of N bytes`，然后返回 ERR，
 *      看起来像"网络问题"，其实是路径不存在；
 *    · 加上重试用的 `sleep` 命令，一共两个 Unix 依赖。
 *    Node 20+ 自带 fetch，标准库、跨平台、不用起子进程。
 */
async function urlCode(u, auth) {
  for (let i = 0; i < 3; i++) {
    try {
      const headers = { 'User-Agent': 'dsh-publish' }
      if (auth && TOKEN) headers.Authorization = `Bearer ${TOKEN}`
      const res = await fetch(u, { method: 'GET', headers, signal: AbortSignal.timeout(20000) })
      const code = String(res.status)
      if (/^\d{3}$/.test(code)) return code
    } catch (e) {}
    if (i < 2) sleepSync(1000)
  }
  return 'ERR'
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

// ——————————————————————————————————————————————————————————————
console.log('\n一、本地仓库自检')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
if (pkg.name === REPO) ok(`package.json 名字正确：${pkg.name} @ ${pkg.version}`)
else { bad(`package.json 名字是 ${pkg.name}，应该是 ${REPO}`); problems++ }

if (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) {
  const patch = path.join(ROOT, pkg.dsh.bundle.patch)
  if (fs.existsSync(patch)) ok(`dsh.bundle 指向的 ${pkg.dsh.bundle.patch} 存在（市场硬性要求）`)
  else { bad(`dsh.bundle 指向 ${pkg.dsh.bundle.patch}，但文件不存在`); problems++ }
} else { bad('package.json 里没有 dsh.bundle —— 市场会直接打回'); problems++ }

const authorStr = JSON.stringify(pkg.author || '')
if (authorStr.includes('Andersen216')) {
  ok('署名：Andersen216' + (authorStr.includes('github.com/Andersen216') ? '（带 GitHub 主页链接）' : '（建议在 author.url 里补上 GitHub 主页）'))
} else { bad(`package.json 的 author 不是 Andersen216：${authorStr}`); problems++ }

for (const f of ['AUTHORS.md', 'PROVENANCE.md', 'LICENSE', 'README.md', 'CHANGELOG.md', 'cordis.patch.yml']) {
  if (fs.existsSync(path.join(ROOT, f))) ok(`文件在：${f}`)
  else { bad(`缺文件：${f}`); problems++ }
}

const lic = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8')
if (lic.includes('Andersen216') && lic.includes('非商业') && lic.includes('CC BY-NC-SA')) ok('LICENSE：代码 MIT（Andersen216）+ 素材非商业声明')
else { bad('LICENSE 里缺少署名或非商业声明'); problems++ }

const authors = fs.readFileSync(path.join(ROOT, 'AUTHORS.md'), 'utf8')
for (const who of ['上善无形', 'ZipZipPipe', '氵六青']) {
  if (authors.includes(who)) ok(`署名齐了：${who}`)
  else { bad(`AUTHORS.md 里没有 ${who}`); problems++ }
}

if (fs.existsSync(path.join(ROOT, '.git'))) {
  const dirty = git('status', '--porcelain')
  if (!dirty) ok('git 工作区干净，已提交')
  else { bad(`git 还有没提交的改动：\n${dirty.split('\n').slice(0, 5).map((l) => '      ' + l).join('\n')}`); problems++ }
  const remote = git('remote', '-v')
  ok(remote ? `remote 已配置：${remote.split('\n')[0]}` : '还没配 remote（脚本会自己加）')
} else { bad('这里不是 git 仓库（先 git init）'); problems++ }

// ——————————————————————————————————————————————————————————————
console.log('\n二、远端撞名检查（npm / GitHub 都已经有三家同类插件了，必须挡）')

for (const n of [REPO]) {
  const c = await urlCode(`https://registry.npmjs.org/${n}`)
  if (c === '404') ok(`npm 名字空闲：${n}`)
  else if (c === 'ERR') info(`npm 上 ${n} 这次没查通（网络问题，不是撞名）——发布前建议再跑一次自检`)
  else { bad(`npm 上 ${n} 已被占用（HTTP ${c}）—— 插件名撞车会导致市场装到别人的包`); problems++ }
}
const repoCode = await urlCode(`https://api.github.com/repos/${OWNER}/${REPO}`, true)
if (repoCode === '404') ok(`GitHub 仓库还没建：${OWNER}/${REPO}（脚本会建）`)
else if (repoCode === '200') ok(`GitHub 仓库已存在，将更新：${OWNER}/${REPO}`)
else { bad(`查 GitHub 仓库失败：HTTP ${repoCode}`); problems++ }

// ——————————————————————————————————————————————————————————————
console.log('\n三、市场条目')

const ZH = ('DSH 里的 Live2D 桌宠「鲸鱼娘」：模型常驻 Web 界面，跟着 agent 的真实状态换表情与动作'
  + '（思考、调工具、逐字输出、报错、收工庆祝），点一下就能直接给 agent 发消息、'
  + '回复逐字冒进气泡；右键菜单可换表情、戴眼镜贴纸、摆桌面场景、演一次性小动作，'
  + '动作全部照模型作者自己的按键表设计，互不冲突、到点自动收回。'
  + '模型素材非商业（CC BY-NC-SA 4.0，作者 上善无形 / ZipZipPipe / 氵六青），'
  + '代码 MIT（原作者 Andersen216）；本增强版 fork 由 H-Canopy 维护。')
const EN = ('A Live2D whale-girl companion for the DeepSeek Harness Web UI: the model stays on '
  + 'screen and reacts to what the agent is actually doing (thinking, tool calls, streaming '
  + 'text, errors, turn completion); click her to send the agent a message and watch the reply '
  + 'stream into a speech bubble; right-click for a menu of expressions, dress-up items, desk '
  + 'scenes and one-shot animations, every action mapped from the original model author hotkey '
  + 'sheet so nothing overlaps and everything expires on its own. Non-commercial model assets '
  + '(CC BY-NC-SA 4.0, by the original character/model artists), MIT code by Andersen216; '
  + 'this enhanced fork is maintained by H-Canopy (https://github.com/H-Canopy).')

const entryFile = `${OWNER}__${REPO}.yml`
const entryYaml = `url: https://github.com/${OWNER}/${REPO}\n`
  + `name: ${OWNER}/${REPO}\n`
  + `category: ${CATEGORY}\n`
  + `description:\n  en: '${EN}'\n  zh: '${ZH}'\n`
info(`市场条目文件：data/plugins/${entryFile}`)
info(`描述长度：en ${EN.length} / zh ${ZH.length} 字（都是一行，含冒号已用单引号包住）`)
if (!/^[\w.-]+__[\w.-]+\.yml$/.test(entryFile)) { bad('条目文件名格式不对（要 owner__repo.yml）'); problems++ }
else ok('条目文件名格式正确')

// ——————————————————————————————————————————————————————————————
if (CHECK_ONLY) {
  console.log(`\n自检结束：${problems === 0 ? '全部通过 ✅' : `有 ${problems} 个问题 ❌`}`)
  console.log(TOKEN
    ? `  （已找到 token（${process.env.GITHUB_TOKEN || process.env.GH_TOKEN ? '环境变量' : 'macOS 钥匙串'}），去掉 --check 就能真发布）\n`
    : '  （没找到 token：真发布需要在环境变量里给 GITHUB_TOKEN，或先存进 macOS 钥匙串，见文件头注释）\n')
  process.exit(problems ? 1 : 0)
}

if (!TOKEN) {
  console.error('\n缺 GITHUB_TOKEN。用法：GITHUB_TOKEN=xxx node tools/publish.mjs\n')
  process.exit(2)
}
if (problems) {
  console.error('\n自检没过，先修问题再发布。\n')
  process.exit(1)
}

// ——————————————————————————————————————————————————————————————
console.log('\n四、建仓库 + 推代码')

const existing = gh('GET', `https://api.github.com/repos/${OWNER}/${REPO}`)
if (existing && existing.full_name) {
  ok(`仓库已存在：${existing.full_name}（直接推）`)
} else {
  const made = gh('POST', 'https://api.github.com/user/repos', {
    name: REPO,
    description: '鲸鱼娘桌宠：DSH Web 界面里的 Live2D 桌宠（模型素材非商业，CC BY-NC-SA 4.0）',
    homepage: `https://github.com/${OWNER}/${REPO}`,
    private: false,
    has_issues: true,
    has_wiki: false,
    topics: ['dsh', 'dsh-plugin', 'deepseek-harness', 'live2d', 'desktop-pet'],
  })
  if (made && made.full_name) ok(`建好了：${made.full_name}`)
  else { console.error('建仓库失败：', JSON.stringify(made).slice(0, 300)); process.exit(1) }
}

const pushUrl = `https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git`
try {
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd: ROOT, stdio: 'ignore' })
} catch (e) {}
execFileSync('git', ['remote', 'add', 'origin', pushUrl], { cwd: ROOT })
execFileSync('git', ['push', '-u', 'origin', `${BRANCH}:${BRANCH}`], { cwd: ROOT, stdio: 'inherit' })
// 推完把带 token 的 remote 换回干净地址，别把 token 留在 .git/config 里
execFileSync('git', ['remote', 'set-url', 'origin', `https://github.com/${OWNER}/${REPO}.git`], { cwd: ROOT })
ok('代码已推送，remote 里的 token 已换成干净地址')

// ——————————————————————————————————————————————————————————————
if (SKIP_PR) {
  console.log('\n跳过市场 PR（--no-pr）。仓库地址：')
  console.log(`  https://github.com/${OWNER}/${REPO}\n`)
  process.exit(0)
}

console.log('\n五、给插件市场提 PR')

const me = gh('GET', 'https://api.github.com/user')
const login = me && me.login
if (!login) { console.error('拿不到 token 对应的账号名'); process.exit(1) }
ok(`token 账号：${login}`)

const fork = gh('POST', `https://api.github.com/repos/${LIST_OWNER}/${LIST_REPO}/forks`, {})
let forkReady = false
for (let i = 0; i < 20; i++) {
  const c = await urlCode(`https://api.github.com/repos/${login}/${LIST_REPO}`, true)
  if (c === '200') { forkReady = true; break }
  sleepSync(1500)
}
if (!forkReady) { console.error('fork 还没就绪，稍后重跑本脚本即可（仓库已推好，只会补提 PR）'); process.exit(1) }
ok(`fork 就绪：${login}/${LIST_REPO}`)

const branch = `add-${REPO}`
const base = gh('GET', `https://api.github.com/repos/${login}/${LIST_REPO}/git/ref/heads/${BRANCH}`)
const baseSha = base && base.object && base.object.sha
if (!baseSha) { console.error('拿不到 fork 的 HEAD'); process.exit(1) }
const ref = gh('POST', `https://api.github.com/repos/${login}/${LIST_REPO}/git/refs`,
  { ref: `refs/heads/${branch}`, sha: baseSha })
if (ref && ref.ref) ok(`建了分支：${branch}`)
else ok('分支已存在，直接覆盖那个文件')

const put = gh('PUT', `https://api.github.com/repos/${login}/${LIST_REPO}/contents/data/plugins/${entryFile}`, {
  message: `Add ${REPO}: DSH 里的 Live2D 桌宠「鲸鱼娘」`,
  content: Buffer.from(entryYaml, 'utf8').toString('base64'),
  branch,
})
if (put && (put.commit || put.content)) ok(`条目已提交：data/plugins/${entryFile}`)
else { console.error('写条目失败：', JSON.stringify(put).slice(0, 300)); process.exit(1) }

const pr = gh('POST', `https://api.github.com/repos/${LIST_OWNER}/${LIST_REPO}/pulls`, {
  title: `Add ${REPO} — 鲸鱼娘桌宠（Live2D desktop pet）`,
  head: `${login}:${branch}`,
  base: BRANCH,
  body: [
    `**${OWNER}/${REPO}** — 鲸鱼娘桌宠：把 Live2D 鲸鱼娘挂进 DSH Web 界面。`,
    '',
    '- 模型常驻桌面，跟着 agent 的真实状态换表情与动作（思考/调工具/逐字输出/报错/收工）',
    '- 点一下直接给 agent 发消息，回复逐字冒进气泡；拖动可挪位置并自动贴边',
    '- 右键菜单：表情 / 装饰 / 场景 / 一次性动作，全部照模型作者的按键表设计，互不冲突',
    '- `package.json` 已有 `dsh.bundle` → `cordis.patch.yml`，可直接安装',
    '- 许可：代码 MIT（Andersen216）；模型素材 CC BY-NC-SA 4.0，非商业，署名 上善无形 / ZipZipPipe / 氵六青',
  ].join('\n'),
})
if (pr && pr.html_url) {
  console.log(`\n🎉 PR 已开：${pr.html_url}`)
  console.log('   合并后站点与 dshmarket 当天就会收录。\n')
} else {
  console.error('开 PR 失败：', JSON.stringify(pr).slice(0, 300))
  console.error('（条目已经写进 fork 了，可以手动去 GitHub 开 PR）\n')
  process.exit(1)
}
