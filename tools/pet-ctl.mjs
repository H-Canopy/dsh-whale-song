#!/usr/bin/env node
/**
 * pet-ctl.mjs —— 让 agent（或你）从命令行直接指挥桌宠。
 *
 * 桌宠的表情/道具大部分由 agent 的真实事件自动驱动；这个命令是「主动表演」的
 * 补充通道：比如打完招呼让它挥挥手，或者完成任务后让它比个耶。
 *
 * 用法（默认打 http://127.0.0.1:3080）：
 *   dsh-pet status                      看桌宠在不在、当前会话、连接数
 *   dsh-pet mood happy                  换情绪（listening/thinking/happy/cry/angry/...）
 *   dsh-pet expr 星星眼                  直接指定表情
 *   dsh-pet motion selfie               播一个动作
 *   dsh-pet say "搞定了！"               弹一句话（只显示，不发给模型）
 *   dsh-pet prop 猫猫贴纸 on             戴道具（on/off）
 *   dsh-pet clear                       摘掉全部道具
 *   dsh-pet ask "要我继续吗？"           弹气泡 + 把桌宠面板打开（提醒用户）
 *
 * 环境变量 DSH_PET_URL 可覆盖地址；也支持 --url。
 */

const argv = process.argv.slice(2)
const urlIdx = argv.indexOf('--url')
const BASE =
  (urlIdx !== -1 ? argv[urlIdx + 1] : null) ||
  process.env.DSH_PET_URL ||
  process.env.DSH_PET_BASE ||
  'http://127.0.0.1:3080'
const args = urlIdx !== -1 ? argv.filter((_, i) => i !== urlIdx && i !== urlIdx + 1) : argv

const [cmd, ...rest] = args

/** 中文别名 → 情绪键，方便直接说人话 */
const MOOD_ALIAS = {
  中性: 'neutral',
  平常: 'neutral',
  倾听: 'listening',
  思考: 'thinking',
  开心: 'happy',
  兴奋: 'excited',
  爱心: 'love',
  脸红: 'shy',
  悲伤: 'sad',
  哭: 'cry',
  生气: 'angry',
  调皮: 'playful',
  晕: 'dizzy',
  阴暗: 'gloomy',
  流汗: 'sweat',
  疑惑: 'confused',
  问号: 'confused',
  感叹: 'alert',
  困: 'sleepy',
  睡: 'sleepy',
  吐舌: 'tongue',
  吐魂: 'dead',
}

const PROP_ALIAS = {
  圆眼镜: 'glassesRound',
  方眼镜: 'glassesSquare',
  椭圆眼镜: 'glassesOval',
  墨镜: 'glassesSun',
  猫猫贴纸: 'stickerCat',
  兔兔贴纸: 'stickerRabbit',
  蝴蝶结贴纸: 'stickerBow',
  情绪花花: 'flower',
  心跳: 'heartbeat',
  单边马尾: 'ponytail',
  发箍: 'headband',
  喵喵手: 'catPaw',
  双手比耶: 'doubleV',
  深色桌布: 'darkCloth',
  头顶鲸鱼: 'whale',
  鲸鱼放桌上: 'whaleOnDesk',
  桌面巴菲: 'parfait',
  粉魔爪: 'claws',
  白魔爪: 'clawsWhite',
  蛋包饭: 'omurice',
  手机换色: 'phoneSkin',
  点菜板: 'menuBoard',
}

const MOTION_HINT = Object.keys({
  idle: 1,
  aidale: 1,
  selfie: 1,
  selfieQuick: 1,
  ketchup: 1,
  openLid: 1,
  bubble: 1,
  splash: 1,
})

async function call(pathname, body) {
  const res = await fetch(BASE + '/dsh-pet' + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch (e) {
    json = { raw: text }
  }
  if (!res.ok) throw new Error(`${res.status} ${json.error || text.slice(0, 200)}`)
  return json
}

function usage(code) {
  process.stdout.write(
    [
      '用法: dsh-pet <命令> [参数]',
      '',
      '  status                     桌宠连接状态',
      '  mood <情绪>                换情绪（happy / 生气 / cry / sleepy …）',
      '  expr <表情名>              直接指定表情（星星眼 / 爱心眼 …）',
      '  motion <动作>              播放动作（selfie / bubble / splash / aidale …）',
      '  say <文字>                 弹一句话',
      '  ask <文字>                 弹一句话并打开桌宠面板',
      '  prop <道具> on|off         戴/摘道具（猫猫贴纸 / 墨镜 / 头顶鲸鱼 …）',
      '  clear                      摘掉全部道具',
      '',
      `当前目标: ${BASE}`,
      '',
    ].join('\n'),
  )
  process.exit(code)
}

async function main() {
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') usage(0)

  if (cmd === 'status') {
    const s = await call('/state')
    process.stdout.write(
      `桌宠: ${s.ok ? '在线' : '离线'}\n插件版本: ${s.version}\n当前会话: ${s.sessionId || '(还没开始对话)'}\n` +
        `agent 状态: ${s.status}\n已连接页面: ${s.clients}\n会话控制器: ${s.hasSessionController ? '可用' : '不可用'}\n`,
    )
    return
  }

  if (cmd === 'mood') {
    const key = MOOD_ALIAS[rest[0]] || rest[0]
    if (!key) usage(1)
    await call('/control', { mood: key })
    process.stdout.write(`情绪 → ${key}\n`)
    return
  }

  if (cmd === 'expr') {
    const name = rest.join(' ')
    if (!name) usage(1)
    await call('/control', { expression: name })
    process.stdout.write(`表情 → ${name}\n`)
    return
  }

  if (cmd === 'motion') {
    const name = rest[0]
    if (!name) {
      process.stdout.write('可用动作: ' + MOTION_HINT.join(' / ') + '\n')
      process.exit(1)
    }
    await call('/control', { motion: name })
    process.stdout.write(`动作 → ${name}\n`)
    return
  }

  if (cmd === 'say' || cmd === 'ask') {
    const text = rest.join(' ')
    if (!text) usage(1)
    await call('/control', cmd === 'ask' ? { say: text, attention: true, bubbleMs: 8000 } : { say: text })
    process.stdout.write(`说了: ${text}\n`)
    return
  }

  if (cmd === 'prop') {
    const key = PROP_ALIAS[rest[0]] || rest[0]
    const on = rest[1] !== 'off' && rest[1] !== 'false' && rest[1] !== '0'
    if (!key) usage(1)
    await call('/control', { props: { [key]: on } })
    process.stdout.write(`${on ? '戴上' : '摘下'} ${rest[0]}\n`)
    return
  }

  if (cmd === 'clear') {
    await call('/control', { clearProps: true })
    process.stdout.write('已摘掉全部道具\n')
    return
  }

  usage(1)
}

main().catch((err) => {
  process.stderr.write(`dsh-pet 失败: ${err.message}\n`)
  process.stderr.write('（桌宠所在的 DSH Web 没在运行？还是端口不是 3080？用 --url 指定。）\n')
  process.exit(1)
})
