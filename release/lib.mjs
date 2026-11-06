/**
 * blacksailflow 安装器共用工具。没有副作用，全部路径由调用方传入。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const MARK_INSTALL = ['# >>> blacksailflow install (managed) >>>', '# <<< blacksailflow install <<<']
export const MARK_PROBE = ['# >>> blacksailflow probe preset (managed) >>>', '# <<< blacksailflow probe preset <<<']

export const readText = (path, fallback = '') => (existsSync(path) ? readFileSync(path, 'utf8') : fallback)
export const readJson = (path, fallback = undefined) => {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8'))
}
export const writeText = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}
export const writeJson = (path, value) => writeText(path, `${JSON.stringify(value, null, 2)}\n`)
export const ensureDir = (path) => mkdirSync(path, { recursive: true })

export const slash = (path) => String(path).replace(/\\/g, '/')

export const stripBlock = (text, [start, end]) => {
  const from = text.indexOf(start)
  if (from < 0) return text
  const to = text.indexOf(end, from)
  if (to < 0) return text
  return `${text.slice(0, from)}${text.slice(to + end.length)}`.replace(/\s+$/, '') + '\n'
}

export const upsertBlock = (text, block, marks) => {
  const stripped = stripBlock(text, marks)
  return `${stripped.replace(/\s+$/, '')}\n\n${block.trimEnd()}\n`
}

/** 备份一个将被改写的文件；返回备份路径（文件不存在时返回 null）。 */
export const backupFile = (sourcePath, backupDir, name) => {
  if (!existsSync(sourcePath)) return null
  const target = join(backupDir, name)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(sourcePath, target)
  return target
}

export const removeIfExists = (path) => {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true })
}

/** 把 hook 命令里的可执行文件和脚本路径都套上双引号，兼容空格路径。 */
export const quote = (part) => `"${part}"`
