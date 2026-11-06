/**
 * blacksailflow 安装校验：只读检查安装结果，任何一项不满足都 exit 1。
 *
 *   node release/verify-install.mjs [--dsh-home=<path>] [--profile=<name>] [--repo=<path>]
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readJson, readText, slash } from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const optionOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : fallback
}

const repoDir = resolve(optionOf('--repo', join(HERE, '..')))
const dshHome = resolve(optionOf('--dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh')))
const profile = optionOf('--profile', 'desktop')
const profileDir = join(dshHome, 'profiles', profile)
const pluginDir = join(repoDir, 'runtime-plugin')
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// 1. 插件本体
const pluginPkgPath = join(pluginDir, 'package.json')
const pluginPkg = readJson(pluginPkgPath, null)
check('插件入口与 bundle patch 存在', existsSync(join(pluginDir, 'index.js')) && existsSync(join(pluginDir, 'cordis.patch.yml')))
check('插件声明 dsh.bundle.patch', pluginPkg?.dsh?.bundle?.patch === './cordis.patch.yml', String(pluginPkg?.dsh?.bundle?.patch))

// 2. 插件 bundle patch 不含机器绝对路径
const pluginPatch = readText(join(pluginDir, 'cordis.patch.yml'))
check('插件 bundle patch 无写死路径', !/[A-Za-z]:[\\/]|sessionsRoot:|projectRoot:|storePath:/.test(pluginPatch))

// 3. profile 依赖与 bundles
const pkg = readJson(join(profileDir, 'package.json'), null)
const linked = pkg?.dependencies?.['@local/blacksailflow']
check('profile 依赖指向本仓库插件', typeof linked === 'string' && linked === `link:${slash(pluginDir)}`, String(linked))
let linkTarget = null
try {
  linkTarget = realpathSync(join(profileDir, 'node_modules', '@local', 'blacksailflow'))
} catch {
  linkTarget = null
}
check('node_modules 链接指向本仓库插件', linkTarget === realpathSync(pluginDir), String(linkTarget))
check('profile bundles 含 @local/blacksailflow', Boolean(pkg?.dsh?.profile?.bundles?.includes('@local/blacksailflow')))
check('profile bundles 含 base 与 web-app', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].every((name) => pkg?.dsh?.profile?.bundles?.includes(name)))

// 4. 插件行来自 bundle patch；profile patch 只在缺 hooks 行时补块
const profilePatch = readText(join(profileDir, 'cordis.patch.yml'))
check('插件 bundle patch 声明 blacksailflow 行', /id:\s*blacksailflow/.test(pluginPatch))
const hasStart = profilePatch.includes('# >>> blacksailflow install (managed) >>>')
const hasEnd = profilePatch.includes('# <<< blacksailflow install <<<')
check('profile patch 安装块起止成对', hasStart === hasEnd, `start=${hasStart} end=${hasEnd}`)
check(
  'profile patch 声明 hooks-claude-code 行并指向本 profile',
  /id:\s*hooks-claude-code/.test(profilePatch) && slash(profilePatch).includes(slash(join(profileDir, 'hooks.json'))),
)

// 5. hooks.json 三个事件都指向存在的脚本
const hooksJson = readJson(join(profileDir, 'hooks.json'), null)
const wanted = { SessionStart: 'task-discipline-hook.mjs', UserPromptSubmit: 'task-discipline-hook.mjs', Stop: 'stop-autoloop.mjs' }
for (const [event, script] of Object.entries(wanted)) {
  const entries = hooksJson?.hooks?.[event] ?? []
  const commands = entries.flatMap((entry) => (entry?.hooks ?? []).map((hook) => String(hook?.command ?? '')))
  const command = commands.find((line) => line.includes(script))
  const scriptPath = command ? command.split('"').find((part) => part.includes(script)) : undefined
  check(`hooks.json ${event} 指向 ${script} 且文件存在`, Boolean(scriptPath) && existsSync(scriptPath), scriptPath ?? '未注册')
}

// 6. 任务表
const boardPath = join(dshHome, 'blacksailflow', 'manifest.json')
const board = readJson(boardPath, null)
check('任务表可读且有 tasks 数组', Array.isArray(board?.tasks), boardPath)

// 7. 技能与源文件一致
const skillsSource = join(repoDir, 'skills')
const skillsTarget = join(dshHome, 'skills')
const sources = readdirSync(skillsSource, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
const missing = sources.filter((name) => {
  const target = join(skillsTarget, name, 'SKILL.md')
  return !existsSync(target) || readFileSync(target, 'utf8') !== readFileSync(join(skillsSource, name, 'SKILL.md'), 'utf8')
})
check(`技能 ${sources.length} 个已安装且与源一致`, missing.length === 0, missing.join(', '))

// 8. 安装状态与可选探针 preset
const state = readJson(join(profileDir, 'bsf-install-state.json'), null)
check('安装状态文件存在', Boolean(state), join(profileDir, 'bsf-install-state.json'))
if (state?.withProbePreset) {
  check('探针 preset 影子插件存在', existsSync(join(repoDir, 'preset-probe', 'skill-shadow.mjs')))
  check('探针 preset 块存在', profilePatch.includes('# >>> blacksailflow probe preset (managed) >>>'))
}

console.log(failures.length === 0 ? '\n安装校验通过' : `\n安装校验失败：${failures.length} 项`)
process.exit(failures.length === 0 ? 0 : 1)
