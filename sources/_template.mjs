// ============================================================================
// sources/_template.mjs —— 音源适配器模板（文件名以 _ 开头 ⇒ 不会被加载）
// ----------------------------------------------------------------------------
// 复制这个文件、改个名字（例如 netease.mjs / qq.mjs），按需实现函数即可。
// 只有 manifest.capabilities 里声明了的能力才需要导出对应函数。
// 硬规则见本目录 README.md：不碰凭据、不绕版权、不做任意代码执行、失败要说话。
// ============================================================================

export const manifest = {
  id: 'example',              // 唯一 id：只能 [a-z0-9-]，2~32 位
  label: '示例音源',           // 菜单里显示的名字
  version: '1.0.0',
  author: 'you',
  license: 'MIT',
  capabilities: ['detect', 'search', 'play'],   // 只能是白名单里的能力
  platform: ['win32'],        // 可选：不写 = 全平台
}

/**
 * 这台机器上有没有这个播放器？
 * @returns {Promise<{ok:boolean, reason?:string}>} 做不到就 ok:false + 人话原因，别假装支持
 */
export async function detect(ctx) {
  return { ok: false, reason: '模板不做检测' }
}

/**
 * 搜索。
 * @returns {Promise<{ok:boolean, items?:Array, reason?:string}>}
 *   items 建议形状：{ id, title, artist, album, extra }
 */
export async function search(ctx, q, limit) {
  return { ok: false, reason: '模板未实现 search' }
}

/**
 * 点播（交给官方客户端去播；适配器自己不解码音频）。
 * @returns {Promise<{ok:boolean, url?:string, reason?:string}>}
 */
export async function play(ctx, item) {
  return { ok: false, reason: '模板未实现 play' }
}
