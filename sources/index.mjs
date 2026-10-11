// ============================================================================
// sources/index.mjs —— 音源适配器的加载器与校验（鲸歌增量）
// ----------------------------------------------------------------------------
// 规则（详见本目录 README.md）：
//   · 只加载本目录下的 *.mjs；文件名以 _ 开头的忽略（模板/草稿）
//   · manifest 必须有 id / label / capabilities；id 只能 [a-z0-9-]，2~32 位
//   · capabilities 只能是白名单里的值
//   · 声明了 detect/search/play/launch 就必须真的导出同名函数
//   · 校验不过 → 该适配器被标记为 ok:false 并带上原因（**不抛错、不影响其它适配器**）
// 安全：本加载器只 import **本目录内的文件**，不接受远程地址、不做动态代码执行。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 宿主允许的能力白名单 */
export const CAPABILITIES = ['detect', 'search', 'play', 'launch', 'playlist', 'control', 'readState']
/** 这些能力如果被声明，就必须真的有对应导出函数 */
export const FUNCTIONAL = ['detect', 'search', 'play', 'launch']

/** 列出可加载的适配器文件（排除模板与加载器自身） */
export function listSourceFiles(dir = HERE) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && f !== 'index.mjs')
    .sort()
    .map((f) => path.join(dir, f))
}

/** 校验 manifest；返回错误数组（空数组 = 通过） */
export function validateManifest(m) {
  const errs = []
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['manifest 必须是一个对象']
  for (const k of ['id', 'label', 'capabilities']) if (!m[k]) errs.push('缺字段 ' + k)
  if (m.id && !/^[a-z0-9-]{2,32}$/.test(String(m.id))) errs.push('id 只能是小写字母/数字/连字符，长度 2~32')
  if (!Array.isArray(m.capabilities)) errs.push('capabilities 必须是数组')
  else {
    for (const c of m.capabilities) {
      if (!CAPABILITIES.includes(c)) errs.push('能力不在白名单里：' + c)
    }
    if (new Set(m.capabilities).size !== m.capabilities.length) errs.push('capabilities 里有重复项')
  }
  if (m.platform && !Array.isArray(m.platform)) errs.push('platform 必须是数组')
  return errs
}

/** 加载并校验一个适配器文件；返回 {file, ok, manifest?, mod?, errors?} */
export async function loadSource(file) {
  let mod
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (err) {
    return { file, ok: false, errors: ['import 失败：' + String((err && err.message) || err)] }
  }
  const errs = validateManifest(mod.manifest)
  const caps = (mod.manifest && Array.isArray(mod.manifest.capabilities)) ? mod.manifest.capabilities : []
  for (const c of caps) {
    if (FUNCTIONAL.includes(c) && typeof mod[c] !== 'function') errs.push('声明了 ' + c + ' 但没有导出该函数')
  }
  if (errs.length) return { file, ok: false, errors: errs }
  return { file, ok: true, manifest: mod.manifest, mod }
}

/** 加载整个目录；返回数组（含校验失败的条目，便于界面提示"哪个适配器坏了"） */
export async function loadSources(dir = HERE) {
  const out = []
  for (const f of listSourceFiles(dir)) out.push(await loadSource(f))
  return out
}

/** 只拿可用的适配器 */
export async function usableSources(dir = HERE) {
  return (await loadSources(dir)).filter((s) => s.ok)
}
