/**
 * blacksailflow 卸载器：移除安装器写入的 profile 片段、hooks 条目、依赖与创建物。
 *
 *   node release/uninstall.mjs [--dsh-home=<path>] [--profile=<name>] [--repo=<path>] [--restore]
 *
 * 默认只删除安装器自己写入的内容（起止标记内、命令含插件 hooks 路径的条目、记录在
 * bsf-install-state.json 的创建物），用户自己加的配置原样保留。
 * --restore 额外把最近一次安装备份覆盖回去（回到安装前状态）。
 */
import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MARK_INSTALL, MARK_PROBE, readJson, readText, slash, stripBlock, writeJson, writeText } from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const optionOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : fallback
}
const restore = new Set(process.argv.slice(2)).has('--restore')

const dshHome = resolve(optionOf('--dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh')))
const profile = optionOf('--profile', 'desktop')
const profileDir = join(dshHome, 'profiles', profile)
const repoDir = resolve(optionOf('--repo', join(HERE, '..')))
const pluginDir = join(repoDir, 'runtime-plugin')
const statePath = join(profileDir, 'bsf-install-state.json')
const state = readJson(statePath, null)
const hooksPrefix = slash(join(pluginDir, 'hooks'))

const removed = []

// 1. patch 块
const patchPath = join(profileDir, 'cordis.patch.yml')
if (existsSync(patchPath)) {
  const before = readText(patchPath)
  const after = stripBlock(stripBlock(before, MARK_PROBE), MARK_INSTALL)
  if (after !== before) {
    writeText(patchPath, after)
    removed.push(`${patchPath}（装配块）`)
  }
}

// 2. hooks.json 里由安装器加的条目
const hooksPath = join(profileDir, 'hooks.json')
if (existsSync(hooksPath)) {
  const hooksJson = readJson(hooksPath)
  let touched = false
  for (const [event, entries] of Object.entries(hooksJson?.hooks ?? {})) {
    const kept = entries.filter((entry) => {
      const hit = (entry?.hooks ?? []).some((hook) => slash(String(hook?.command ?? '')).includes(hooksPrefix))
      return !hit
    })
    if (kept.length !== entries.length) {
      hooksJson.hooks[event] = kept
      touched = true
    }
  }
  if (touched) {
    writeJson(hooksPath, hooksJson)
    removed.push(`${hooksPath}（三个 hook 条目）`)
  }
}

// 3. profile package.json 里的依赖与 bundle 项
const pkgPath = join(profileDir, 'package.json')
if (existsSync(pkgPath)) {
  const pkg = readJson(pkgPath)
  let touched = false
  if (pkg?.dependencies?.['@local/blacksailflow']) {
    delete pkg.dependencies['@local/blacksailflow']
    touched = true
  }
  const bundles = pkg?.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes('@local/blacksailflow')) {
    pkg.dsh.profile.bundles = bundles.filter((name) => name !== '@local/blacksailflow')
    touched = true
  }
  if (touched) {
    writeJson(pkgPath, pkg)
    removed.push(`${pkgPath}（依赖与 bundles 项）`)
  }
}

// 4. 安装器创建的文件与目录
const boardPath = join(dshHome, 'blacksailflow', 'manifest.json')
for (const path of state?.createdPaths ?? []) {
  if (path === boardPath) continue
  if (!existsSync(path)) continue
  const info = lstatSync(path)
  if (info.isSymbolicLink()) unlinkSync(path)
  else rmSync(path, { force: true })
  removed.push(path)
  // 清理因此变空的技能目录
  const parent = dirname(path)
  if (parent.startsWith(join(dshHome, 'skills')) && existsSync(parent) && readdirSync(parent).length === 0) {
    rmSync(parent, { recursive: true, force: true })
    removed.push(parent)
  }
}

// 5. 任务表：安装器创建且仍为空时删除，否则保留并说明
if (existsSync(boardPath)) {
  const board = readJson(boardPath)
  const empty = (board?.tasks ?? []).length === 0 && (board?.archived ?? []).length === 0
  if (empty && (state?.createdPaths ?? []).includes(boardPath)) {
    rmSync(boardPath, { force: true })
    removed.push(boardPath)
  } else {
    console.log(`保留任务表（非空或非安装器创建）：${boardPath}`)
  }
}

// 6. --restore：把第一次安装前的备份覆盖回去（最早一份才是安装前状态）
if (restore) {
  const backupRoot = join(profileDir, 'bsf-install-backup')
  const candidates = existsSync(backupRoot)
    ? readdirSync(backupRoot).sort().map((name) => join(backupRoot, name))
    : []
  const backupDir = candidates.find((path) => existsSync(path)) ?? state?.backupDir
  if (!backupDir || !existsSync(backupDir)) {
    console.log('没有可用备份，--restore 跳过')
  } else {
    for (const name of ['package.json', 'hooks.json', 'cordis.patch.yml']) {
      const from = join(backupDir, name)
      if (!existsSync(from)) continue
      writeText(join(profileDir, name), readText(from))
      removed.push(`${join(profileDir, name)}（从备份恢复）`)
    }
    // 备份若取自后续运行，可能仍带装配块：恢复后再剥一次，保证回到安装前。
    const restoredPatch = stripBlock(stripBlock(readText(patchPath), MARK_PROBE), MARK_INSTALL)
    writeText(patchPath, restoredPatch)
  }
}

// 7. 安装状态
if (existsSync(statePath)) {
  rmSync(statePath, { force: true })
  removed.push(statePath)
}

if (removed.length === 0) console.log('没有发现 blacksailflow 安装痕迹，未做修改')
else for (const item of removed) console.log(`removed  ${item}`)
console.log(`卸载完成：${removed.length} 项`)
process.exit(0)
