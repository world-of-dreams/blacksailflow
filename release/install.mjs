/**
 * blacksailflow 安装器：把 profile、hooks.json、任务表、技能与（可选）探针 preset 对齐。
 *
 *   node release/install.mjs [--dsh-home=<path>] [--profile=<name>] [--repo=<path>]
 *                            [--with-probe-preset] [--dry-run]
 *
 * 幂等：目标内容已一致时不动文件，因此第二次运行只输出 unchanged。
 * 不覆盖用户已有配置：package.json / hooks.json 只增补缺项；patch 块带起止标记。
 * 每个被改写的文件在改前复制到 <profile>/bsf-install-backup/<时间戳>/。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MARK_INSTALL,
  MARK_PROBE,
  backupFile,
  ensureDir,
  quote,
  readJson,
  readText,
  slash,
  stripBlock,
  upsertBlock,
  writeJson,
  writeText,
} from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const flags = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith('--dsh-home') && !arg.startsWith('--profile') && !arg.startsWith('--repo')))
const optionOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : fallback
}

const repoDir = resolve(optionOf('--repo', join(HERE, '..')))
const dshHome = resolve(optionOf('--dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh')))
const profile = optionOf('--profile', 'desktop')
const profileDir = join(dshHome, 'profiles', profile)
const pluginDir = join(repoDir, 'runtime-plugin')
const skillsSource = join(repoDir, 'skills')
const skillsTarget = join(dshHome, 'skills')
const nodePath = process.execPath
const withProbe = flags.has('--with-probe-preset')
const dryRun = flags.has('--dry-run')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupRoot = join(profileDir, 'bsf-install-backup', stamp)
const report = { created: [], changed: [], unchanged: [] }
let backedUp = false

if (!existsSync(join(pluginDir, 'index.js'))) {
  console.error(`找不到插件入口：${join(pluginDir, 'index.js')}（用 --repo 指向 blacksailflow 仓库根）`)
  process.exit(2)
}

/** 写文件并归类；内容相同就不碰磁盘。 */
const commitText = (path, next, backupName) => {
  const current = readText(path, '')
  if (current === next) {
    report.unchanged.push(path)
    return false
  }
  if (!existsSync(path)) report.created.push(path)
  else report.changed.push(path)
  if (dryRun) return true
  const backup = backupFile(path, backupRoot, backupName)
  if (backup) backedUp = true
  writeText(path, next)
  return true
}
const commitJson = (path, next, backupName) => commitText(path, `${JSON.stringify(next, null, 2)}\n`, backupName)

// 1. 任务表
const boardPath = join(dshHome, 'blacksailflow', 'manifest.json')
if (!existsSync(boardPath)) {
  if (!dryRun) writeJson(boardPath, { rev: 0, tasks: [], archived: [] })
  report.created.push(boardPath)
} else {
  report.unchanged.push(boardPath)
}

// 2. 技能
ensureDir(skillsTarget)
const skillNames = readdirSync(skillsSource, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(skillsSource, entry.name, 'SKILL.md')))
  .map((entry) => entry.name)
for (const name of skillNames) {
  const target = join(skillsTarget, name, 'SKILL.md')
  commitText(target, readFileSync(join(skillsSource, name, 'SKILL.md'), 'utf8'), `skills/${name}/SKILL.md`)
}

// 3. profile package.json
const pkgPath = join(profileDir, 'package.json')
const pkg = readJson(pkgPath, null) ?? {
  name: `dsh-profile-${profile}`,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: [] } },
}
pkg.dependencies ??= {}
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []
if (pkg.dsh.profile.bundles.length === 0)
  pkg.dsh.profile.bundles.push('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app')
pkg.dependencies['@local/blacksailflow'] = `link:${slash(pluginDir)}`
if (!pkg.dsh.profile.bundles.includes('@local/blacksailflow')) pkg.dsh.profile.bundles.push('@local/blacksailflow')
commitJson(pkgPath, pkg, 'package.json')

// 3b. node_modules 链接（等价于 pnpm 的 link: 安装结果，免去包管理器依赖）
const linkPath = join(profileDir, 'node_modules', '@local', 'blacksailflow')
let linkCurrent = null
try {
  linkCurrent = realpathSync(linkPath)
} catch {
  linkCurrent = null
}
if (linkCurrent === realpathSync(pluginDir)) {
  report.unchanged.push(linkPath)
} else {
  if (!dryRun) {
    ensureDir(dirname(linkPath))
    if (linkCurrent) rmSync(linkPath, { force: true })
    symlinkSync(pluginDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  }
  if (linkCurrent) report.changed.push(linkPath)
  else report.created.push(linkPath)
}

// 4. profile cordis.patch.yml
// 插件通过 package.json 的 dsh.profile.bundles 注册，其 bundle patch 自己 insert blacksailflow 行，
// 这里不能再写一条同 id 的 insert（会重复 id）。只有缺 hooks-claude-code 行时才补装配块。
const patchPath = join(profileDir, 'cordis.patch.yml')
const patchText = readText(patchPath, '')
const hooksJsonPath = join(profileDir, 'hooks.json')
const patchWithoutBlocks = stripBlock(stripBlock(patchText, MARK_INSTALL), MARK_PROBE)
const needsHooksRow = !/id:\s*hooks-claude-code/.test(patchWithoutBlocks)
const installRows = needsHooksRow
  ? [
      MARK_INSTALL[0],
      '- insert:',
      '    - id: hooks-claude-code',
      "      name: '@deepseek-ai/dsh-hooks-claude-code'",
      '      config:',
      `        configPath: ${slash(hooksJsonPath)}`,
      MARK_INSTALL[1],
    ].join('\n')
  : ''
let nextPatch = needsHooksRow ? upsertBlock(patchText, installRows, MARK_INSTALL) : stripBlock(patchText, MARK_INSTALL)

if (withProbe) {
  const templatePath = join(repoDir, 'preset-probe', '_bsf-preset-block.patch.yml')
  const template = readFileSync(templatePath, 'utf8')
    .replaceAll('__BSF_REPO__', slash(repoDir))
    .split('\n')
    .filter((line) => !line.startsWith('# >>>') && !line.startsWith('# <<<'))
    .join('\n')
  nextPatch = upsertBlock(nextPatch, `${MARK_PROBE[0]}\n${template.trimEnd()}\n${MARK_PROBE[1]}`, MARK_PROBE)
}
commitText(patchPath, nextPatch, 'cordis.patch.yml')

// 5. profile hooks.json（三个事件：SessionStart / UserPromptSubmit / Stop）
const hooksJson = readJson(hooksJsonPath, null) ?? { hooks: {} }
hooksJson.hooks ??= {}
const hookSpecs = [
  ['SessionStart', 'task-discipline-hook.mjs', ['--event=SessionStart'], 30],
  ['UserPromptSubmit', 'task-discipline-hook.mjs', ['--event=UserPromptSubmit'], 30],
  ['Stop', 'stop-autoloop.mjs', [], 15],
]
for (const [event, script, extra, timeout] of hookSpecs) {
  hooksJson.hooks[event] ??= []
  const scriptPath = join(pluginDir, 'hooks', script)
  const command = [quote(nodePath), quote(scriptPath), ...extra].join(' ')
  const present = hooksJson.hooks[event].some((entry) =>
    (entry?.hooks ?? []).some((hook) => String(hook?.command ?? '').includes(slash(scriptPath)) || String(hook?.command ?? '').includes(scriptPath)),
  )
  if (present) continue
  hooksJson.hooks[event].push({ matcher: '*', hooks: [{ type: 'command', command, timeout }] })
}
commitJson(hooksJsonPath, hooksJson, 'hooks.json')

// 6. 安装状态（卸载依据）。已安装环境没有状态文件时补写（adopt），不改动任何配置。
const statePath = join(profileDir, 'bsf-install-state.json')
const previous = readJson(statePath, null)
const ownedSkillPaths = skillNames.map((name) => join(skillsTarget, name, 'SKILL.md'))
const adoptedExisting = previous === null
const state = {
  installedAt: new Date().toISOString(),
  repoDir: slash(repoDir),
  pluginDir: slash(pluginDir),
  dshHome: slash(dshHome),
  profile,
  withProbePreset: withProbe || Boolean(previous?.withProbePreset),
  backupDir: backedUp ? slash(backupRoot) : (previous?.backupDir ?? null),
  createdPaths: [...new Set([...(previous?.createdPaths ?? []), ...report.created, ...(adoptedExisting ? ownedSkillPaths : [])])],
  adoptedExisting: adoptedExisting || Boolean(previous?.adoptedExisting),
}
const sameState = (a, b) =>
  a &&
  b &&
  a.repoDir === b.repoDir &&
  a.pluginDir === b.pluginDir &&
  a.dshHome === b.dshHome &&
  a.profile === b.profile &&
  a.withProbePreset === b.withProbePreset &&
  JSON.stringify(a.createdPaths) === JSON.stringify(b.createdPaths)
if (!sameState(previous, state)) {
  if (!dryRun) writeJson(statePath, state)
  if (adoptedExisting) {
    report.created.push(statePath)
    console.log(`已存在安装：补写安装状态文件（配置未改动）${statePath}`)
  } else report.changed.push(statePath)
} else {
  report.unchanged.push(statePath)
}

const changedCount = report.created.length + report.changed.length
if (changedCount === 0) {
  console.log(`安装检查：已是最新（created=0 changed=0 unchanged=${report.unchanged.length}）`)
  console.log(`profile=${profile} dshHome=${dshHome} repo=${repoDir}`)
} else {
  for (const path of report.created) console.log(`created  ${path}`)
  for (const path of report.changed) console.log(`changed  ${path}`)
  console.log(`安装完成：created=${report.created.length} changed=${report.changed.length} unchanged=${report.unchanged.length}`)
  console.log(`profile=${profile} dshHome=${dshHome} repo=${repoDir}`)
  if (backedUp) console.log(`备份：${backupRoot}`)
  if (withProbe) console.log('已写入探针 preset（bsf-probe-filter）；preset revision 在重启后生效。')
}
process.exit(0)
