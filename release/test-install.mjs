/**
 * 安装器自测：在临时 DSH home 里跑 安装 → 再安装（幂等）→ 校验 → 卸载(--restore) → 校验失败。
 *
 *   node release/test-install.mjs      exit 0 = 全部断言通过
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(join(HERE, '..'))
const sandbox = mkdtempSync(join(tmpdir(), 'bsf-install-test-'))
const dshHome = join(sandbox, 'dsh')
const profileDir = join(dshHome, 'profiles', 'desktop')
const script = (name) => join(HERE, name)
const run = (...args) => spawnSync(process.execPath, args, { env: { ...process.env, DSH_HOME: dshHome }, encoding: 'utf8' })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const basePkg = {
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}
const baseHooks = { hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user-hook', timeout: 5 }] }] } }
const basePatch = '- insert:\n    - id: user-row\n      disabled: true\n'

const { mkdirSync, writeFileSync } = await import('node:fs')
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(basePkg, null, 2)}\n`, 'utf8')
writeFileSync(join(profileDir, 'hooks.json'), `${JSON.stringify(baseHooks, null, 2)}\n`, 'utf8')
writeFileSync(join(profileDir, 'cordis.patch.yml'), basePatch, 'utf8')

const install1 = run(script('install.mjs'), `--dsh-home=${dshHome}`, `--profile=desktop`, `--repo=${repoDir}`)
check('首次安装 exit 0', install1.status === 0, install1.stderr.trim())
check('首次安装报告 created', install1.stdout.includes('created=') && !install1.stdout.includes('created=0 changed=0'))

const patchAfter1 = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
const hooksAfter1 = readFileSync(join(profileDir, 'hooks.json'), 'utf8')
const pkgAfter1 = readFileSync(join(profileDir, 'package.json'), 'utf8')
check('安装后用户行保留', patchAfter1.includes('id: user-row'))
check('安装后用户 hook 保留', hooksAfter1.includes('echo user-hook'))
check('安装块写入', patchAfter1.includes('# >>> blacksailflow install (managed) >>>'))
check('三个事件注册', ['task-discipline-hook.mjs', 'stop-autoloop.mjs'].every((name) => hooksAfter1.includes(name)))
check('依赖与 bundle 写入', JSON.parse(pkgAfter1).dependencies['@local/blacksailflow']?.startsWith('link:'))
check('任务表已建', Array.isArray(JSON.parse(readFileSync(join(dshHome, 'blacksailflow', 'manifest.json'), 'utf8')).tasks))
check('技能已装 8 个', readdirSync(join(dshHome, 'skills')).length === 8)

const install2 = run(script('install.mjs'), `--dsh-home=${dshHome}`, `--profile=desktop`, `--repo=${repoDir}`)
check('二次安装 exit 0', install2.status === 0, install2.stderr.trim())
check('二次安装幂等（未改动文件）', install2.stdout.includes('已是最新'))
check('二次安装后 patch 字节不变', readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8') === patchAfter1)
check('二次安装后 hooks 字节不变', readFileSync(join(profileDir, 'hooks.json'), 'utf8') === hooksAfter1)

const verify1 = run(script('verify-install.mjs'), `--dsh-home=${dshHome}`, `--profile=desktop`, `--repo=${repoDir}`)
check('校验安装 exit 0', verify1.status === 0, verify1.stdout.split('\n').filter((line) => line.startsWith('FAIL')).join(' | '))

const uninstall = run(script('uninstall.mjs'), `--dsh-home=${dshHome}`, `--profile=desktop`, `--repo=${repoDir}`, '--restore')
check('卸载 exit 0', uninstall.status === 0, uninstall.stderr.trim())
const patchAfterUn = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
const hooksAfterUn = readFileSync(join(profileDir, 'hooks.json'), 'utf8')
const pkgAfterUn = readFileSync(join(profileDir, 'package.json'), 'utf8')
check('卸载后回到安装前的 patch', patchAfterUn === basePatch, patchAfterUn)
check('卸载后回到安装前的 hooks', JSON.stringify(JSON.parse(hooksAfterUn)) === JSON.stringify(baseHooks))
check('卸载后回到安装前的 package.json', JSON.stringify(JSON.parse(pkgAfterUn)) === JSON.stringify(basePkg))
check('卸载后技能目录已清', !existsSync(join(dshHome, 'skills')) || readdirSync(join(dshHome, 'skills')).length === 0)
check('卸载后任务表已删', !existsSync(join(dshHome, 'blacksailflow', 'manifest.json')))

const verify2 = run(script('verify-install.mjs'), `--dsh-home=${dshHome}`, `--profile=desktop`, `--repo=${repoDir}`)
check('卸载后校验 exit 1', verify2.status === 1, `status=${verify2.status}`)

// 可选探针 preset：装 → 校验 → 卸载时一并移除
const probeHome = join(sandbox, 'dsh-probe')
const probeProfile = join(probeHome, 'profiles', 'desktop')
mkdirSync(probeProfile, { recursive: true })
writeFileSync(join(probeProfile, 'package.json'), `${JSON.stringify(basePkg, null, 2)}\n`, 'utf8')
writeFileSync(join(probeProfile, 'hooks.json'), `${JSON.stringify(baseHooks, null, 2)}\n`, 'utf8')
writeFileSync(join(probeProfile, 'cordis.patch.yml'), basePatch, 'utf8')
const probeInstall = spawnSync(
  process.execPath,
  [script('install.mjs'), `--dsh-home=${probeHome}`, '--profile=desktop', `--repo=${repoDir}`, '--with-probe-preset'],
  { env: { ...process.env, DSH_HOME: probeHome }, encoding: 'utf8' },
)
const probePatch = readFileSync(join(probeProfile, 'cordis.patch.yml'), 'utf8')
check('探针 preset 安装 exit 0', probeInstall.status === 0, probeInstall.stderr.trim())
check('探针 preset 块写入', probePatch.includes('# >>> blacksailflow probe preset (managed) >>>'))
check(
  '探针 preset 影子行指向本仓库文件',
  probePatch.includes(`${repoDir.replace(/\\/g, '/')}/preset-probe/skill-shadow.mjs`),
)
const probeVerify = spawnSync(
  process.execPath,
  [script('verify-install.mjs'), `--dsh-home=${probeHome}`, '--profile=desktop', `--repo=${repoDir}`],
  { env: { ...process.env, DSH_HOME: probeHome }, encoding: 'utf8' },
)
check('探针 preset 校验 exit 0', probeVerify.status === 0, probeVerify.stdout.split('\n').filter((line) => line.startsWith('FAIL')).join(' | '))
spawnSync(process.execPath, [script('uninstall.mjs'), `--dsh-home=${probeHome}`, '--profile=desktop', `--repo=${repoDir}`], {
  env: { ...process.env, DSH_HOME: probeHome },
  encoding: 'utf8',
})
check('卸载后探针 preset 块已移除', !readFileSync(join(probeProfile, 'cordis.patch.yml'), 'utf8').includes('bsf-probe-filter'))

rmSync(sandbox, { recursive: true, force: true })
console.log(failures.length === 0 ? '\n安装器自测通过' : `\n安装器自测失败：${failures.length} 项`)
process.exit(failures.length === 0 ? 0 : 1)
