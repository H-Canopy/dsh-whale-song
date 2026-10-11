// 给 harness 造一个可播放的测试音频（不依赖任何真实音乐文件）
// 生成一段 1 秒的 8kHz 单声道 WAV 正弦波 —— 浏览器能解码、能被 <audio> 播放，
// 用来验证"本地音乐栏能列出并真的播起来"。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIR = path.join(DSH_HOME, 'whale-music')
fs.mkdirSync(DIR, { recursive: true })

function wav(seconds, freq, rate) {
  const n = Math.floor(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000)
    data.writeInt16LE(v, i * 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)   // PCM
  head.writeUInt16LE(1, 22)   // mono
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

const names = ['probe-tone-a.wav', 'probe-tone-b.wav']
names.forEach((name, i) => {
  const file = path.join(DIR, name)
  fs.writeFileSync(file, wav(1, 440 + i * 220, 8000))
  console.log('写出 ' + file + ' (' + fs.statSync(file).size + ' 字节)')
})
console.log('托管目录: ' + DIR)
