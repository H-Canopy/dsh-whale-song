// Deterministic shell generation. Edit templates/*.cjs, not desktop/standalone/main.js/preload.js.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const OUT = path.join(REPO, 'desktop', 'standalone')
for (const name of ['main', 'preload']) {
  const template = path.join(HERE, 'templates', name + '.cjs')
  const result = spawnSync(process.execPath, ['--check', template], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'Template syntax check failed')
  const source = fs.readFileSync(template, 'utf8')
  const banner = '// GENERATED: edit tools/shell-gen/templates/' + name + '.cjs and run node tools/shell-gen/make-standalone-shell.mjs\n'
  fs.writeFileSync(path.join(OUT, name + '.js'), banner + source, 'utf8')
  console.log('Generated desktop/standalone/' + name + '.js')
}
