/**
 * 角色钩子层（方案 B）：在插件内按 agent 角色分设行为。
 *
 * 角色判定（已实测，2026-11-05）：
 *   ctx.agentTeams.tryMembership(agent) → role 'lead' | 'teammate'
 *   ctx.agents.roots() → 根 agent（独立会话 / Team Lead）
 *   其余 → 子代理（hand）
 *   实测记录：lead→captain、teammate→mate、subagent→hand，全部可区分。
 *
 * 能力（已实测）：
 *   agent.inject(普通对象) 可用；agent.steer(普通对象) 可用；
 *   消息形状 { role:'user', content:[{type:'text',text}], source }。
 *
 * 开局不注入任何身份段：未定档只注入 hooks/untiered-guide.md；定档后按档注入
 * hooks/09（single-task）/ 10（single-group）/ 02（cross-group）正文 + 随档技能路由。
 * 本文件只负责"按档注入 / 按角色检查 / 按角色拦截"。
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { BOARD_PATH, HOOK_DIR, ROLE_PROBE_PATH } from './paths.mjs'

/** 常驻规则唯一来源：与 runtime-plugin/hooks/task-discipline-hook.mjs 同一文件同一路径。 */
const RESIDENT_FILE = `${HOOK_DIR}/resident-rules.md`

/** 三档工作方式：档位决定注入的正文与技能路由；未定档不注入任何身份段。 */
const WORK_MODE_FILE = {
  'single-task': `${HOOK_DIR}/mode-single-task.md`,
  'single-group': `${HOOK_DIR}/mode-single-group.md`,
  'cross-group': `${HOOK_DIR}/captain-charter.md`,
}
export const WORK_MODES = ['single-task', 'single-group', 'cross-group']
/** 档位对应的技能路由角色：单任务 hand、单群 mate、跨群 captain。 */
const MODE_ROLE = { 'single-task': 'hand', 'single-group': 'mate', 'cross-group': 'captain' }
/** 未定档引导：只给规模判断与定档入口，不含身份段。 */
const GUIDE_FILE = `${HOOK_DIR}/untiered-guide.md`
/** 没显式 set 时的默认档位；只用于回合自检，不参与 agent/created 注入。 */
const DEFAULT_WORK_MODE = { captain: 'cross-group', mate: 'single-group', hand: 'single-task' }
/** 显式 set 的档位按会话存（进程内有效，重启后回到未定档）。 */
const workModeBySession = new Map()

/** 按角色隐藏的技能：只用于目录文本裁剪；工具级不拒载，仍可从目录外加载。 */
const HIDDEN_SKILLS = {
  captain: ['bsf-manifest', 'bsf-chore', 'bsf-livefire', 'bsf-scout'],
  mate: ['bsf-chart', 'bsf-commission'],
  hand: ['bsf-chart', 'bsf-commission', 'bsf-manifest', 'bsf-chore', 'bsf-livefire', 'bsf-logbook', 'bsf-parrot'],
}

/** 技能目录行：`- \`name\`: description`。 */
const SKILL_CATALOG_LINE = /^- `([a-z0-9]+(?:-[a-z0-9]+)*)`:/i

/**
 * 目录消息按角色裁行。只改文本，保留 source.entries 原样：
 * dsh-tool-skill 用 source.entries 算 digest，改它会每步重新发布目录。
 */
function stripHiddenCatalogLines(message, hidden) {
  const content = Array.isArray(message?.content) ? message.content : []
  let changed = false
  const nextContent = content.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block
    const lines = block.text.split('\n')
    const kept = lines.filter((line) => {
      const match = SKILL_CATALOG_LINE.exec(line)
      return !(match && hidden.includes(match[1]))
    })
    if (kept.length === lines.length) return block
    changed = true
    return { ...block, text: kept.join('\n') }
  })
  return changed ? { ...message, content: nextContent } : undefined
}

/** 按角色过滤一个 step 的入站消息：只裁目录行；/技能名 正文注入不再丢弃（工具级不拒载）。 */
function filterSkillMessages(messages, hidden) {
  if (hidden.length === 0) return undefined
  let changed = false
  const next = []
  for (const message of messages) {
    const source = message?.source
    if (source?.kind === 'skill-catalog') {
      const stripped = stripHiddenCatalogLines(message, hidden)
      if (stripped !== undefined) {
        changed = true
        next.push(stripped)
        continue
      }
    }
    next.push(message)
  }
  return changed ? next : undefined
}

const FILTER_PROVIDER = 'blacksailflow-role-filter'

/**
 * hand 直写拦截（2026-11-05 扩到全部写路径）
 * 覆盖面：文件写工具（write/edit 及同类）、命令工具（pwsh/bash 等，命令串里出现任务表路径即拦）、
 *        其余任何工具（参数序列化后命中任务表路径即拦）。bf_* 是唯一放行通道。
 * 已知不覆盖：把路径拆成多段字符串拼接后再写（命令串里不出现完整 blacksailflow/manifest.json）。
 */
const BOARD_MARK = 'blacksailflow/manifest.json'
const GUARD_READ_TOOLS = new Set(['read', 'grep', 'glob', 'read_image'])
const GUARD_WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'multi_edit', 'create_file', 'replace_in_file'])
const GUARD_SHELL_TOOLS = new Set(['pwsh', 'powershell', 'bash', 'sh', 'shell', 'exec', 'cmd', 'run_command', 'terminal'])
const normaliseText = (value) => String(value ?? '').toLowerCase().replace(/\\/g, '/')
const mentionsBoard = (value) => normaliseText(value).includes(BOARD_MARK)
const boardWriteTarget = (name, args) => {
  if (GUARD_READ_TOOLS.has(name)) return false
  if (GUARD_WRITE_TOOLS.has(name))
    return ['file_path', 'path', 'target', 'filePath'].some((key) => mentionsBoard(args?.[key]))
  if (GUARD_SHELL_TOOLS.has(name))
    return ['command', 'script', 'cmd', 'input'].some((key) => mentionsBoard(args?.[key]))
  return mentionsBoard(JSON.stringify(args ?? {}))
}

/**
 * hand 的 bf_* 权限面：只能追加 evidence、改任务 status；acceptance / deps / owner 与归档归 mate。
 * 拦在工具入口，防 hand 通过 bf_manifest_update 改别人任务的验收口径。
 */
const HAND_BLOCKED_UPDATE_FIELDS = ['acceptance', 'deps', 'owner']
const handToolDenial = (name, args) => {
  if (name === 'bf_manifest_archive') return 'hand 不能归档/删除任务；归档由 mate 用 bf_manifest_archive。'
  if (name === 'bf_manifest_update') {
    const blocked = HAND_BLOCKED_UPDATE_FIELDS.filter((field) => args?.[field] !== undefined)
    if (blocked.length > 0)
      return `hand 不能改 ${blocked.join(' / ')}；acceptance / deps / owner 归 mate，hand 只追加 evidence、改任务 status。`
  }
  return undefined
}

/**
 * 在 agent 自己的 scope 里注册一个影子 provider：同名条目以 modelInvocable=false 覆盖全局层，
 * 于是只有该 agent 看不到这些技能（skills 服务分层合并，最近层同名条目胜出）。
 */
function installSkillFilter(ctx, agent, role) {
  const hidden = HIDDEN_SKILLS[role] ?? []
  if (hidden.length === 0) return
  try {
    const scopedSkills = agent?.ctx?.get?.('skills') ?? ctx.get('skills')
    if (!scopedSkills?.registerProvider) return
    const candidates = hidden.map((name) => ({
      name,
      description: '',
      source: 'runtime',
      provider: FILTER_PROVIDER,
      rank: 0,
      invocation: { modelInvocable: false, userInvocable: false },
    }))
    scopedSkills.registerProvider(() => ({
      name: FILTER_PROVIDER,
      async list() {
        return { candidates, complete: true }
      },
      async get() {
        return undefined
      },
    }))
  } catch {
    // 注册失败时退化为【可用技能】路由指引。
  }
}
const SKILL_ROUTE = {
  captain: '【可用技能】bsf-chart 切群、bsf-commission 派 mate、bsf-parrot 问需求、bsf-logbook 记录。不加载 mate/hand 的执行类技能。',
  mate: '【可用技能】bsf-manifest 拆任务、bsf-chore 派 hand、bsf-livefire 交付前验证、bsf-scout 定位、bsf-parrot 问需求、bsf-logbook 记录。',
  hand: '【可用技能】只有定位不明时才用 bsf-scout；其余按 mate 给的任务文字直接做，不加载管理与规划类技能。',
}

const hookTextCache = new Map()

/** 读 hook 文件正文：去掉 '# ' 标题行后 trim；文件缺失返回空串。 */
function hookText(file) {
  if (hookTextCache.has(file)) return hookTextCache.get(file)
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('# '))
      .join('\n')
      .trim()
  } catch {
    text = ''
  }
  hookTextCache.set(file, text)
  return text
}

/** 某档正文：single-task→09、single-group→10、cross-group→02。 */
export function workModeText(mode) {
  const file = WORK_MODE_FILE[mode]
  return file ? hookText(file) : ''
}

/** 未定档引导正文（hooks/untiered-guide.md）。 */
export function guideText() {
  return hookText(GUIDE_FILE)
}

/**
 * 档位组合文本（正文 + '\n\n' + 随档技能路由）：bf_work_mode set 与 agent/created
 * 已定档恢复共用这一个函数；全仓库只在这里拼接正文与路由。
 */
export function modeInjectionText(mode) {
  const body = workModeText(mode)
  return [body, SKILL_ROUTE[MODE_ROLE[mode]] ?? ''].filter(Boolean).join('\n\n')
}

/** 初始注入文本：已显式定档 → 当前档位组合文本；未定档 → hooks/13 引导。ctx 保留签名。 */
export function initialInjectionText(ctx, agent) {
  const stored = agent?.id ? workModeBySession.get(agent.id) : undefined
  return stored ? modeInjectionText(stored.mode) : guideText()
}

let residentCache

/** hooks/resident-rules.md 正文（去掉标题行）；压缩重锚与常驻注入读同一文件。 */
export function residentRulesText() {
  if (residentCache !== undefined) return residentCache
  try {
    residentCache = readFileSync(RESIDENT_FILE, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('# '))
      .join('\n')
      .trim()
  } catch {
    residentCache = ''
  }
  return residentCache
}

/** 当前会话档位：显式 set 优先，没有就按角色默认（默认档位只用于回合自检）。 */
export function workModeState(agent, role) {
  const stored = agent?.id ? workModeBySession.get(agent.id) : undefined
  if (stored) return { mode: stored.mode, group: stored.group, source: 'explicit' }
  return { mode: DEFAULT_WORK_MODE[role] ?? 'single-task', group: null, source: 'default' }
}

/** set：记下本会话档位，并追加注入该档组合文本（正文 + 随档路由）；切换不清除已注入内容。 */
export function applyWorkMode(agent, mode, group) {
  const text = modeInjectionText(mode)
  if (!text) throw new Error(`work mode text is missing for ${mode}`)
  agent.inject(message(text))
  workModeBySession.set(agent.id, { mode, group: group ?? null })
  return { mode, group: group ?? null, source: 'explicit' }
}

function readBoard() {
  try {
    return JSON.parse(readFileSync(BOARD_PATH, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

function message(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'blacksailflow' } }
}

function classify(ctx, agent) {
  try {
    const membership = ctx.get('agentTeams')?.tryMembership?.(agent)
    if (membership?.role === 'lead') return 'captain'
    if (membership?.role === 'teammate') return 'mate'
  } catch {
    // 服务缺失时按根判定。
  }
  try {
    const roots = ctx.get('agents')?.roots?.() ?? []
    if (roots.includes(agent)) return 'captain'
  } catch {
    // 忽略。
  }
  return 'hand'
}

/** 本会话的 teammate 名；取不到（非 teammate / 服务缺失）返回 undefined。 */
function teammateName(ctx, agent) {
  try {
    const membership = ctx.get('agentTeams')?.tryMembership?.(agent)
    return membership?.role === 'teammate' ? membership.name : undefined
  } catch {
    return undefined
  }
}

/** 该 send_message 调用是否发往 lead（真实工具 schema 是 { target, message }，lead 的 target 为 'lead'）。 */
function sendMessageToLead(exec) {
  return String(exec?.arguments?.target ?? '') === 'lead'
}

/** 任务是否归本会话：owner 等于会话 id、本会话 membership 名，或 hand:<会话 id 前 8 位>。 */
function ownsBySession(task, sessionId, name) {
  const owner = String(task?.owner ?? '').trim()
  if (!owner || !sessionId) return false
  if (owner === sessionId) return true
  if (name && owner === name) return true
  if (!owner.startsWith('hand:')) return false
  const prefix = owner.slice('hand:'.length)
  return prefix.length > 0 && sessionId.startsWith(prefix)
}

/** cross-group：现行 captain 口径，未派群（非 done、无 owner 的群节点）。 */
function captainScopeText(tasks) {
  const unassigned = tasks.filter((task) => task.kind === 'group' && !task.owner && task.status !== 'done')
  if (unassigned.length === 0) return ''
  return `回合结束前：任务表还有 ${unassigned.length} 个群没有交给 mate（${unassigned
    .slice(0, 5)
    .map((task) => task.id)
    .join('、')}）。先派出去，或明确写清为什么还没派。`
}

/** single-group：指定群内未派 ready + 该群 blocked（blocked 且本回合没发 lead 时提醒上行询问）。 */
function groupScopeText(ctx, agent, tasks, group, sentToLead) {
  let groupIds
  if (group) {
    groupIds = new Set([group])
  } else {
    const name = teammateName(ctx, agent)
    if (!name) return ''
    groupIds = new Set(tasks.filter((task) => task.kind === 'group' && task.owner === name).map((task) => task.id))
  }
  const inOwnGroup = (task) => task.group !== null && groupIds.has(task.group)
  const texts = []
  const blocked = tasks.filter((task) => inOwnGroup(task) && task.status === 'blocked')
  if (blocked.length > 0 && !sentToLead) {
    texts.push(
      `回合结束前：本群有 ${blocked.length} 条 blocked 任务（${blocked
        .slice(0, 5)
        .map((task) => task.id)
        .join('、')}），本回合没有把阻塞发给 lead。先用 send_message 向 lead 发一条结构化询问再结束：背景（卡在哪一步、谁在等）、已确认（有命令/退出码/产物支撑的事实）、待定（要 lead 拍板的点）、选项（每个做法的代价、能否反悔、你的建议）、影响（不决定会卡住哪些任务）。等 lead 答复后再继续。`,
    )
  }
  const unassigned = tasks.filter(
    (task) => task.kind !== 'group' && !task.owner && task.status === 'ready' && inOwnGroup(task),
  )
  if (unassigned.length > 0) {
    texts.push(
      `回合结束前：本群还有 ${unassigned.length} 条 ready 任务没有派给 hand（${unassigned
        .slice(0, 5)
        .map((task) => task.id)
        .join('、')}）。派下去，或写清在等什么。`,
    )
  }
  return texts.join('\n\n')
}

/** single-task：本会话名下 running 任务。 */
function taskScopeText(ctx, agent, tasks) {
  const sessionId = typeof agent?.id === 'string' ? agent.id : ''
  if (!sessionId) return ''
  const name = teammateName(ctx, agent)
  const running = tasks.filter((task) => task.status === 'running' && ownsBySession(task, sessionId, name))
  if (running.length === 0) return ''
  return `回合结束前：任务表还有 ${running.length} 个进行中的任务（${running
    .slice(0, 5)
    .map((task) => task.id)
    .join('、')}）。交回时必须带结论、证据（命令/退出码/产物）、未解决项；没达标就继续修，或写清卡在哪、等谁。`
}

/** mate 回合结束的固定要求：无未派、无 blocked 时也要带上，合并进同一条 steer。 */
const MATE_EVIDENCE = '交回前必须给真实测试证据：命令 + 退出码 + 产物路径；自述不算达标。'

/** captain 回合结束的固定要求：拍板与驳回要留档，无未派群时也要带上。 */
const CAPTAIN_LOGBOOK = '回合结束前：用 bsf-logbook 记录本轮决策与边界（拍板 / 驳回 / 跨群契约变化）。'
/** mate 回合结束的固定要求：与证据行合并成同一条 steer。 */
const MATE_LOGBOOK = '回合结束前：用 bsf-logbook 记录本群进度与结论（做了什么 / 证据 / 剩下什么）。'

/** 回合结束时的检查文案；返回空串表示不拦。档位由显式 set 或角色默认映射决定。 */
function turnCheckText(ctx, role, agent, sentToLead) {
  const board = readBoard()
  const tasks = Array.isArray(board?.tasks) ? board.tasks : []
  const { mode, group } = workModeState(agent, role)
  let base = ''
  if (mode === 'cross-group') base = captainScopeText(tasks)
  else if (mode === 'single-group') base = groupScopeText(ctx, agent, tasks, group, sentToLead)
  else base = taskScopeText(ctx, agent, tasks)
  if (role === 'captain') return [base, CAPTAIN_LOGBOOK].filter(Boolean).join('\n\n')
  if (role === 'mate') return [base, MATE_EVIDENCE, MATE_LOGBOOK].filter(Boolean).join('\n\n')
  return base
}

export function installRoleHooks(ctx, config = {}) {
  const identityEnabled = config.identity !== false
  const turnCheckEnabled = config.turnCheck !== false
  const guardEnabled = config.guard !== false
  const skillLayersEnabled = config.skillLayers !== false
  const roleOf = new WeakMap()
  const steered = new Map()
  /** 本回合内已向 lead 发过 send_message 的 agent；每次 turn-stopping 消费并清空。 */
  const uplinkSent = new Set()

  // 技能目录按层裁剪：dsh-tool-skill 在每个 step 的 agent/pre-step 里现算目录消息；
  // prepend 让我们位于其外层，await next() 后改最终消息。只改文本、不动 source.entries。
  ctx.effect(() =>
    ctx.on(
      'agent/pre-step',
      async ({ agent, messages }, next) => {
        const decision = await next()
        if (!skillLayersEnabled || decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
        const role = agent ? (roleOf.get(agent) ?? classify(ctx, agent)) : undefined
        if (!role) return decision
        const filtered = filterSkillMessages(decision.messages, HIDDEN_SKILLS[role] ?? [])
        return filtered === undefined ? decision : { ...decision, messages: filtered }
      },
      { prepend: true },
    ),
  )

  ctx.effect(() =>
    ctx.on('agent/created', ({ agent, source }) => {
      const role = classify(ctx, agent)
      roleOf.set(agent, role)
      // 真隐藏需要 provider 在插件 apply 期注册进目标 scope；agent/created 时动态注册会破坏该 agent，
      // 故默认关闭，只保留按角色路由指引。开启仅用于实验：config.skillFilter = true。
      if (config.skillFilter === true) installSkillFilter(ctx, agent, role)
      if (!identityEnabled) return
      const text = initialInjectionText(ctx, agent)
      if (!text) return
      try {
        agent.inject(message(text))
      } catch {
        // 注入失败不阻塞创建。
      }
    }),
  )

  ctx.effect(() =>
    ctx.on('agent/turn-stopping', ({ agent }) => {
      if (!turnCheckEnabled) return
      const role = roleOf.get(agent) ?? classify(ctx, agent)
      const sentToLead = uplinkSent.has(agent)
      uplinkSent.delete(agent)
      const text = turnCheckText(ctx, role, agent, sentToLead)
      if (!text) return
      const key = agent?.id ?? 'unknown'
      const now = Date.now()
      const previous = steered.get(key) ?? { count: 0, at: 0 }
      if (previous.count >= 3 || now - previous.at < 600000) return
      steered.set(key, { count: previous.count + 1, at: now })
      try {
        agent.steer(message(text))
      } catch {
        // 拦回失败就当没拦。
      }
    }),
  )

  ctx.effect(() =>
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.agent && String(exec.name ?? '') === 'send_message' && sendMessageToLead(exec)) {
        uplinkSent.add(exec.agent)
      }
      const role = exec.agent ? (roleOf.get(exec.agent) ?? classify(ctx, exec.agent)) : undefined
      if (!guardEnabled) return next()
      if (role !== 'hand') return next()
      const name = String(exec.name ?? '')
      const args = exec.arguments ?? exec.args
      const denial = name.startsWith('bf_') ? handToolDenial(name, args) : undefined
      if (denial) return { kind: 'deny', reason: denial }
      if (name.startsWith('bf_')) return next()
      if (!boardWriteTarget(name, args)) return next()
      return {
        kind: 'deny',
        reason:
          'hand 不能直接改任务表文件。写：bf_manifest_update（只改 status / evidence）；读：bf_manifest_list。归档与验收口径由 mate 改。',
      }
    }),
  )
}

/** 探针：把分类事实写入 role-probe.jsonl，用于复核角色判定。 */
export function installRoleProbe(ctx) {
  ctx.effect(() =>
    ctx.on('agent/created', ({ agent, source }) => {
      const facts = { at: new Date().toISOString(), source, sessionId: agent?.id ?? null }
      try {
        const membership = ctx.get('agentTeams')?.tryMembership?.(agent)
        facts.team = membership ? { role: membership.role, name: membership.name } : null
      } catch (error) {
        facts.teamError = String(error?.message ?? error)
      }
      try {
        const roots = ctx.get('agents')?.roots?.() ?? []
        facts.isRoot = roots.includes(agent)
      } catch {
        // 忽略。
      }
      facts.role = classify(ctx, agent)
      try {
        agent.inject(message(`[role-probe] 你的角色判定为 ${facts.role}`))
      } catch {
        // 忽略。
      }
      try {
        appendFileSync(
          ROLE_PROBE_PATH,
          JSON.stringify(facts) + '\n',
          'utf8',
        )
      } catch {
        // 忽略。
      }
    }),
  )
}
