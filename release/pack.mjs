/**
 * 生成开源发布包：只打产品文件到 release/out/blacksailflow-<version>/，写 MANIFEST.json 与 SHA256SUMS。
 *
 *   node release/pack.mjs      exit 0 = 包内只有产品文件（dev-only 零泄漏）
 *
 * 白名单 = 仓库白名单（.gitignore 的反面）；缺任一必需文件直接 exit 1。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(join(HERE, '..'))
const version = JSON.parse(readFileSync(join(REPO, 'runtime-plugin', 'package.json'), 'utf8')).version
const outRoot = join(HERE, 'out')
const outDir = join(outRoot, `blacksailflow-${version}`)

const INCLUDE = [
  'runtime-plugin/index.js',
  'runtime-plugin/roles.mjs',
  'runtime-plugin/hook-forms.mjs',
  'runtime-plugin/fold-titles.mjs',
  'runtime-plugin/goal-rearm.mjs',
  'runtime-plugin/paths.mjs',
  'runtime-plugin/cordis.patch.yml',
  'runtime-plugin/package.json',
  'runtime-plugin/icon.svg',
  'runtime-plugin/locale/en.json',
  'runtime-plugin/locale/zh.json',
  'runtime-plugin/hooks/task-discipline-hook.mjs',
  'runtime-plugin/hooks/stop-autoloop.mjs',
  'hooks/captain-charter.md',
  'hooks/mate-duties.md',
  'hooks/hand-duties.md',
  'hooks/mode-single-task.md',
  'hooks/mode-single-group.md',
  'hooks/resident-rules.md',
  'hooks/untiered-guide.md',
  'skills/bsf-chart/SKILL.md',
  'skills/bsf-chore/SKILL.md',
  'skills/bsf-commission/SKILL.md',
  'skills/bsf-livefire/SKILL.md',
  'skills/bsf-logbook/SKILL.md',
  'skills/bsf-manifest/SKILL.md',
  'skills/bsf-parrot/SKILL.md',
  'skills/bsf-scout/SKILL.md',
  'preset-probe/skill-shadow.mjs',
  'preset-probe/_bsf-preset-block.patch.yml',
  'release/install.mjs',
  'release/uninstall.mjs',
  'release/verify-install.mjs',
  'release/test-install.mjs',
  'release/pack.mjs',
  'release/lib.mjs',
  'release/README.md',
  'AGENT.md',
  'README.md',
  'README.en.md',
  'LICENSE',
]

const REQUIRED = [
  'AGENT.md',
  'LICENSE',
  'README.md',
  'README.en.md',
  'runtime-plugin/index.js',
  'runtime-plugin/roles.mjs',
  'runtime-plugin/paths.mjs',
  'runtime-plugin/cordis.patch.yml',
  'runtime-plugin/hooks/task-discipline-hook.mjs',
  'runtime-plugin/hooks/stop-autoloop.mjs',
  'hooks/resident-rules.md',
  'skills/bsf-chart/SKILL.md',
  'preset-probe/skill-shadow.mjs',
  'release/install.mjs',
  'release/verify-install.mjs',
  'release/README.md',
]

/** 输出包里绝不允许出现的路径（防回归）。 */
const DEV_ONLY = [
  /\.bak(-|$)/,
  /(^|\/)role-probe\.jsonl$/,
  /(^|\/)evidence\.mjs$/,
  /(^|\/)verify-(?!install)[^/]*\.mjs$/,
  /(^|\/)sanitize\.mjs$/,
  /(^|\/)cleanup-manifest-/,
  /(^|\/)docs(\/|$)/,
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)DEV-ONLY\.md$/,
  /(^|\/)RELEASE-MANIFEST\.md$/,
  /(^|\/)AUDIT-external-deps\.md$/,
  /(^|\/)_shipped-/,
  /(^|\/)_dsh-/,
  /(^|\/)build-patch\.mjs$/,
  /(^|\/)check-shadow\.mjs$/,
]

const isDevOnly = (relPath) => DEV_ONLY.some((pattern) => pattern.test(relPath))
const walk = (root, current = root) => {
  const files = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name)
    const rel = relative(root, full).replace(/\\/g, '/')
    if (entry.isDirectory()) { files.push(...walk(root, full)); continue }
    files.push(rel)
  }
  return files
}

const failures = []
for (const required of REQUIRED) if (!INCLUDE.includes(required)) failures.push(`必需文件不在白名单：${required}`)
for (const rel of INCLUDE) if (!existsSync(join(REPO, rel))) failures.push(`白名单路径不存在：${rel}`)
if (failures.length > 0) {
  console.log(failures.join('\n'))
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const manifestFiles = []
for (const rel of [...INCLUDE].sort()) {
  const to = join(outDir, rel)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(join(REPO, rel), to)
  manifestFiles.push({ path: rel, size: statSync(to).size, sha256: sha256(to) })
}

const leaked = walk(outDir, outDir).filter(isDevOnly)
if (leaked.length > 0) {
  console.log(leaked.map((rel) => `dev-only 泄漏：${rel}`).join('\n'))
  process.exit(1)
}

const manifest = { name: 'blacksailflow', version, generatedAt: new Date().toISOString(), fileCount: manifestFiles.length, files: manifestFiles }
writeFileSync(join(outDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
writeFileSync(join(outDir, 'SHA256SUMS'), manifestFiles.map((file) => `${file.sha256}  ${file.path}`).join('\n') + '\n', 'utf8')
console.log(`pack ok: ${manifestFiles.length} files -> ${outDir}`)
console.log('dev-only 命中 0（.bak / role-probe / evidence / verify-* / sanitize / docs / 内部材料）')
