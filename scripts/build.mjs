// 打包成可安装的 .tgz（npm pack 的等价物，不引入额外依赖）
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-formation-'))
const dest = path.join(stage, 'package')
fs.mkdirSync(dest, { recursive: true })

// package.json 必须进包：npm pack 会自动带，手写脚本必须显式加
const ALWAYS = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']
const entries = [...new Set([...ALWAYS, ...pkg.files])].filter((e) => fs.existsSync(path.join(root, e)))

for (const entry of entries) {
  const src = path.join(root, entry)
  const out = path.join(dest, entry)
  fs.cpSync(src, out, { recursive: true })
}

const tgz = path.join(root, `${pkg.name}-${pkg.version}.tgz`)
if (fs.existsSync(tgz)) fs.unlinkSync(tgz)

execFileSync('tar', ['-czf', tgz, '-C', stage, 'package'], { stdio: 'inherit' })
fs.rmSync(stage, { recursive: true, force: true })

const kb = (fs.statSync(tgz).size / 1024).toFixed(1)
console.log(`built ${path.basename(tgz)} (${kb} KB)`)
