// ============================================================================
// test-sources.mjs —— 音源适配器插口的校验测试（毫秒级，不需要浏览器）
// 用临时目录造夹具，验证加载器：合法适配器能装 / 模板被忽略 / 越权能力被拒 /
// 漏实现被拒 / import 报错不影响其它适配器 / manifest 形状不合格被拒。
// 跑：node tools/test-sources.mjs
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'sources')
const { listSourceFiles, validateManifest, loadSources, usableSources, CAPABILITIES } =
  await import(pathToFileURL(path.join(SRC, 'index.mjs')).href)

let bad = 0
const ok = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (c ? '' : '  → ' + d)); if (!c) bad++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'song-sources-'))
const put = (name, body) => { fs.writeFileSync(path.join(tmp, name), body, 'utf8'); return path.join(tmp, name) }

// —— 真实目录：模板必须被忽略 ——
ok(!listSourceFiles(SRC).some((f) => path.basename(f).startsWith('_')), '模板（_ 开头）不会被当作适配器加载', listSourceFiles(SRC).map((f) => path.basename(f)).join(','))

// —— 夹具 ——
put('_draft.mjs', 'export const manifest = {}\n')                       // 应被忽略
put('good.mjs', `
export const manifest = { id: 'good-one', label: '好的', capabilities: ['detect', 'search'], version: '1.0.0' }
export async function detect() { return { ok: true } }
export async function search() { return { ok: true, items: [] } }
`)
put('bad-cap.mjs', `
export const manifest = { id: 'bad-cap', label: '越权', capabilities: ['detect', 'exec'] }
export async function detect() { return { ok: true } }
`)
put('missing-fn.mjs', `
export const manifest = { id: 'missing-fn', label: '漏实现', capabilities: ['detect', 'play'] }
export async function detect() { return { ok: true } }
`)
put('broken.mjs', 'export const manifest = { id: ')                    // 语法坏 → import 应失败但不拖垮别人
put('bad-id.mjs', `
export const manifest = { id: 'Bad ID!', label: '非法 id', capabilities: [] }
`)

const all = await loadSources(tmp)
const byName = (n) => all.find((x) => path.basename(x.file) === n)
ok(all.length === 5, '目录里 5 个文件参与校验（_draft 被忽略）', '' + all.length)
ok(byName('good.mjs') && byName('good.mjs').ok === true, '合法适配器通过校验', JSON.stringify(byName('good.mjs') && byName('good.mjs').errors))
ok(byName('bad-cap.mjs') && byName('bad-cap.mjs').ok === false && byName('bad-cap.mjs').errors.join(' ').includes('白名单'),
  '越权能力（exec）被拒绝', JSON.stringify(byName('bad-cap.mjs') && byName('bad-cap.mjs').errors))
ok(byName('missing-fn.mjs') && byName('missing-fn.mjs').ok === false && byName('missing-fn.mjs').errors.join(' ').includes('没有导出'),
  '声明了能力却没实现 → 被拒绝', JSON.stringify(byName('missing-fn.mjs') && byName('missing-fn.mjs').errors))
ok(byName('broken.mjs') && byName('broken.mjs').ok === false && byName('broken.mjs').errors.join(' ').includes('import 失败'),
  '语法坏的文件只影响自己（import 失败被捕获）', JSON.stringify(byName('broken.mjs') && byName('broken.mjs').errors))
ok(byName('bad-id.mjs') && byName('bad-id.mjs').ok === false, '非法 id 被拒绝', JSON.stringify(byName('bad-id.mjs') && byName('bad-id.mjs').errors))
const usable = await usableSources(tmp)
ok(usable.length === 1 && usable[0].manifest.id === 'good-one', '可用列表只含通过校验的那个', usable.map((s) => s.manifest.id).join(','))

// —— 真实适配器：网易云（sources/netease.mjs）——
// 只测"不联网也确定"的部分：manifest 合法、id/能力、播放链接的构造与拒绝规则。
// 搜索要出网，所以不在这里打真机（点播真机验证要显式授权：见 PLAN-OURS 的记录）。
{
  const real = await loadSources(SRC)
  const ne = real.find((s) => path.basename(s.file) === 'netease.mjs')
  ok(!!ne && ne.ok === true, '真实适配器 netease.mjs 通过校验', JSON.stringify(ne && ne.errors))
  ok(!!ne && ne.manifest.id === 'netease' && ne.manifest.capabilities.includes('play'),
    'netease：id 与能力正确', JSON.stringify(ne && ne.manifest))
  ok(!!ne && ne.manifest.capabilities.indexOf('control') < 0 && ne.manifest.capabilities.indexOf('readState') < 0,
    'netease：遥控/读状态不声明（那是统一层 SMTC 的事）', JSON.stringify(ne && ne.manifest.capabilities))

  const mod = ne && ne.mod
  if (!mod) {
    ok(false, 'netease：模块可加载', '没拿到 mod')
  } else {
    const url = mod.playUrl({ id: '1234567' })
    ok(url === 'orpheus://' + Buffer.from(JSON.stringify({ type: 'song', id: '1234567', cmd: 'play' }), 'utf8').toString('base64'),
      'playUrl：orpheus://base64({"type":"song","id","cmd":"play"})', url)
    const pl = mod.playUrl({ id: '2723543824', kind: 'playlist' })
    let decoded = null
    try { decoded = JSON.parse(Buffer.from(String(pl).replace('orpheus://', ''), 'base64').toString('utf8')) } catch (err) {}
    ok(!!decoded && decoded.type === 'playlist' && decoded.id === '2723543824', 'playUrl：歌单走 type:playlist', JSON.stringify(decoded))
    ok(mod.playUrl({ id: '12; rm -rf' }) === '', 'playUrl：非纯数字 id 一律拒绝（不拼进协议命令）', JSON.stringify(mod.playUrl({ id: '12; rm -rf' })))
    ok(mod.playUrl({}) === '' && mod.playUrl(null) === '', 'playUrl：缺 id 时返回空串（调用方据此报错）', String(mod.playUrl({})))

    const bad = await mod.play({}, { id: 'not-a-number' })
    ok(bad.ok === false && typeof bad.reason === 'string' && bad.reason.length > 0,
      'play：没有可用 id → ok:false + 人话原因', JSON.stringify(bad))

    const s0 = await mod.search({}, '', 5)
    ok(s0.ok === false && /空/.test(s0.reason), 'search：空关键词直接拒（不发请求）', JSON.stringify(s0))

    // detect 在没装客户端的机器上应当"说话"而不是假装支持；装了则 ok:true
    const det = await mod.detect({})
    ok(det && typeof det.ok === 'boolean' && (det.ok === true || (typeof det.reason === 'string' && det.reason.length > 0)),
      'detect：要么 ok:true，要么 ok:false + 人话原因（不假装支持）', JSON.stringify(det))
  }
}

// —— manifest 校验函数本身 ——
ok(validateManifest(null).length === 1, 'validateManifest(null) 报错而不是抛异常', JSON.stringify(validateManifest(null)))
ok(validateManifest({ id: 'x', label: 'y', capabilities: [] }).some((e) => e.includes('长度')), 'id 太短会被指出', JSON.stringify(validateManifest({ id: 'x', label: 'y', capabilities: [] })))
ok(CAPABILITIES.includes('control') && CAPABILITIES.includes('readState'), '白名单里有统一层用到的 control / readState', CAPABILITIES.join(','))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(bad ? '\n结果：失败 ' + bad + ' 项' : '\n结果：全部通过')
process.exit(bad ? 1 : 0)
