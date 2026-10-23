// ============================================================================
// serve-standalone.mjs —— 起一个**只发静态文件**的小服务器，用来试独立模式
// ----------------------------------------------------------------------------
// 为什么需要它：standalone/index.html 走 file:// 也能开，但 file:// 下无头浏览器/排障都不方便
// （fetch 相对路径、CORS、缓存都跟真实环境不一样）。这里起一个零依赖静态服务，
// 把仓库根目录照样映射出去，于是：
//   http://127.0.0.1:41998/standalone/   ← 同一个页面，但是走 HTTP，和"丢到静态托管"一致
// 它**不**注册任何 /dsh-pet/* 接口 —— 这正是要验的：没有后端时她能不能自己渲染起来。
//
//   node tools/serve-standalone.mjs [--port 41998]
// ============================================================================
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const argPort = process.argv.indexOf('--port')
const PORT = argPort >= 0 ? Number(process.argv[argPort + 1]) : 41998

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.css': 'text/css; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.wasm': 'application/wasm',
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(String(req.url || '/').split('?')[0])
  const rel = pathname === '/' ? 'standalone/index.html' : pathname.replace(/^\/+/, '')
  const abs = path.resolve(ROOT, rel)
  // 越界直接拒（哪怕只是本地小工具，也别养成坏习惯）
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('forbidden')
    return
  }
  let stat = null
  try { stat = fs.statSync(abs) } catch (err) {}
  const file = stat && stat.isDirectory() ? path.join(abs, 'index.html') : abs
  let buf = null
  try { buf = fs.readFileSync(file) } catch (err) {}
  if (!buf) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found: ' + pathname)
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
  })
  res.end(buf)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('[standalone] 静态服务已起：http://127.0.0.1:' + PORT + '/standalone/')
  console.log('[standalone] 注意：这里**没有**任何 /dsh-pet/* 接口 —— 验的就是"没有后端她能不能自己站起来"')
})
