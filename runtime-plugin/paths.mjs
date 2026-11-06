/**
 * blacksailflow 运行时路径解析。
 *
 * 优先级：插件 config（显式写在 profile patch，向后兼容）> 环境变量 > 相对安装位置。
 * 没有任何路径写死在本机布局上。
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** runtime-plugin/ 目录（本文件所在目录）。 */
export const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
/** 仓库根（runtime-plugin 的上一级），含 hooks/ 与 skills/。 */
export const REPO_DIR = dirname(PLUGIN_DIR)

/** DSH home。默认 ~/.dsh，可用 DSH_HOME 覆盖。 */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
/** 任务表存储。默认 <DSH_HOME>/blacksailflow/manifest.json，可用 BSF_MANIFEST 覆盖。 */
export const BOARD_PATH = process.env.BSF_MANIFEST ?? join(DSH_HOME, 'blacksailflow', 'manifest.json')
/** 身份/规则 markdown 目录。默认 <REPO_DIR>/hooks，可用 BSF_HOOK_DIR 覆盖。 */
export const HOOK_DIR = process.env.BSF_HOOK_DIR ?? join(REPO_DIR, 'hooks')
/** 会话日志根。默认 <DSH_HOME>/sessions，可用 BSF_SESSIONS_ROOT 覆盖。 */
export const SESSIONS_ROOT = process.env.BSF_SESSIONS_ROOT ?? join(DSH_HOME, 'sessions')
/** bf_brief 进度查询的项目根。默认 <REPO_DIR>，可用 BSF_PROJECT_ROOT 覆盖。 */
export const PROJECT_ROOT = process.env.BSF_PROJECT_ROOT ?? REPO_DIR
/** 角色探针输出。默认 <PLUGIN_DIR>/role-probe.jsonl，可用 BSF_ROLE_PROBE 覆盖。 */
export const ROLE_PROBE_PATH = process.env.BSF_ROLE_PROBE ?? join(PLUGIN_DIR, 'role-probe.jsonl')
/** 钩子进程状态目录。默认 <DSH_HOME>/blacksailflow，可用 BSF_STATE_DIR 覆盖。 */
export const HOOK_STATE_DIR = process.env.BSF_STATE_DIR ?? join(DSH_HOME, 'blacksailflow')
