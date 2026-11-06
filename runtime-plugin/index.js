/**
 * blacksailflow runtime plugin
 *
 * 1. bf_goal: self-owned goals (captain / mate / hand each manage their own session goal)
 * 2. task board: bf_task_add / claim / update / list over one project-wide table
 *
 * The board is data + tools, not a document. Single writer: every mutation is
 * serialized inside this process and persisted through temp-file + rename.
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import { installRoleHooks } from './roles.mjs'
import { installHookForms } from './hook-forms.mjs'
import { installFoldTitles } from './fold-titles.mjs'
import { installGoalRearm } from './goal-rearm.mjs'
import { BOARD_PATH, PROJECT_ROOT, SESSIONS_ROOT } from './paths.mjs'

const execFileAsync = promisify(execFile)
const shellOf = () => (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
const shellArgsOf = (command) => (process.platform === 'win32' ? ['/c', command] : ['-c', command])

export const name = 'blacksailflow-runtime'
export const inject = ['tools', 'goals']

const GOAL_ACTIONS = ['get', 'set', 'resume', 'pause', 'complete', 'block', 'clear']
const TASK_STATUS = ['ready', 'running', 'blocked', 'done', 'failed']

const createStore = (path) => {
  let tail = Promise.resolve()
  const run = (fn) => {
    const next = tail.then(fn)
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const read = async () => {
    try {
      return JSON.parse(await fs.readFile(path, 'utf8'))
    } catch {
      return { rev: 0, tasks: [] }
    }
  }
  const write = async (data) => {
    await fs.mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, path)
  }
  return { run, read, write }
}

const resultShape = () => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  presentationMeta: (_args, value) => value,
})

const goalTool = (ctx) => ({
  name: 'bf_quest',
  description:
    'Manage the calling session own goal. captain / mate / hand can all use it: set creates and arms a goal, get reads it, resume re-arms, pause stops, block marks blocked, complete finishes, clear removes.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: GOAL_ACTIONS },
      objective: { type: 'string', description: 'objective for set' },
      maxGoalRounds: { type: 'integer', description: 'optional auto-continuation round cap' },
      code: { type: 'string', description: 'stable reason code for block' },
      message: { type: 'string', description: 'human readable reason for block' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  output: resultShape(),
  async execute(args, exec) {
    const agent = exec.agent
    if (!agent) throw new Error('bf_goal requires an agent session')
    const goals = ctx.goals
    const current = goals.get(agent)
    const ref = () => {
      if (!current) throw new Error('no goal on this session; use action=set first')
      return { id: current.id, revision: current.revision }
    }
    switch (args.action) {
      case 'get':
        return { ok: true, goal: current ?? null }
      case 'set':
        if (!args.objective) throw new Error('set requires objective')
        return {
          ok: true,
          goal: goals.create(agent, {
            objective: args.objective,
            ...(args.maxGoalRounds === undefined ? {} : { maxGoalRounds: args.maxGoalRounds }),
          }),
        }
      case 'resume':
        return { ok: true, goal: goals.resume(agent, ref()) }
      case 'pause':
        return { ok: true, goal: goals.pause(agent, ref()) }
      case 'complete':
        return { ok: true, goal: goals.complete(agent, ref()) }
      case 'block':
        return {
          ok: true,
          goal: goals.block(agent, ref(), {
            code: args.code ?? 'blocked',
            message: args.message ?? 'no reason given',
          }),
        }
      case 'clear':
        return { ok: true, cleared: goals.clear(agent, ref()) }
      default:
        throw new Error(`unknown action: ${String(args.action)}`)
    }
  },
})

const DISPATCH_WAKE_TIMEOUT_MS = 15000

const goalDispatchTool = (ctx) => ({
  name: 'bf_dispatch_goal',
  description:
    'Team Lead dispatches a goal to a named mate: assign creates and arms the goal on that mate session, status reads it, complete finishes it. An unloaded mate is woken first.',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'mate name in the team roster' },
      objective: { type: 'string', description: 'goal objective for assign' },
      maxGoalRounds: { type: 'integer', description: 'optional auto-continuation round cap' },
      action: { type: 'string', enum: ['assign', 'status', 'complete'], description: 'default assign' },
    },
    required: ['target'],
    additionalProperties: false,
  },
  output: resultShape(),
  async execute(args, exec) {
    const caller = exec.agent
    const teams = ctx.get('agentTeams')
    const membership = teams?.tryMembership?.(caller)
    if (membership?.role !== 'lead') throw new Error('only the Team Lead can dispatch a goal')
    const row = teams.listMembers(caller).find((member) => member.name === args.target)
    if (!row) throw new Error(`unknown teammate: ${args.target}`)

    const agents = ctx.get('agents')
    let agent = agents.get(row.id)
    if (!agent) {
      let dispose
      let timer
      const revived = new Promise((resolve) => {
        dispose = ctx.on('agent/created', ({ agent: created }) => {
          if (created?.id === row.id) resolve(created)
        })
        timer = setTimeout(() => resolve(undefined), DISPATCH_WAKE_TIMEOUT_MS)
      })
      const text =
        args.action === undefined || args.action === 'assign'
          ? `Lead 给你派了 goal：${args.objective}。本回合不必额外动作，回合结束后按 goal 自动续轮。`
          : `Lead 需要处理你的 goal（${args.action}）。本回合不必额外动作。`
      try {
        await teams.sendMessage(caller, {
          target: args.target,
          content: [{ type: 'text', text }],
          signal: exec.signal,
        })
        agent = await revived
      } finally {
        clearTimeout(timer)
        if (typeof dispose === 'function') dispose()
      }
      if (!agent) throw new Error(`teammate ${args.target} did not come back after wake`)
    }

    const action = args.action ?? 'assign'
    if (action === 'status') return { ok: true, target: row.name, goal: ctx.goals.get(agent) ?? null }
    if (action === 'complete') {
      const current = ctx.goals.get(agent)
      if (!current) throw new Error(`no goal on ${args.target}`)
      return {
        ok: true,
        target: row.name,
        goal: ctx.goals.complete(agent, { id: current.id, revision: current.revision }),
      }
    }
    if (action !== 'assign') throw new Error(`unknown action: ${String(action)}`)
    if (!args.objective) throw new Error('assign requires objective')
    const current = ctx.goals.get(agent)
    if (current && current.phase !== 'complete')
      throw new Error(`teammate ${args.target} already has an active goal (${current.phase}); complete or clear it first`)
    return {
      ok: true,
      target: row.name,
      goal: ctx.goals.create(agent, {
        objective: args.objective,
        ...(args.maxGoalRounds ? { maxGoalRounds: args.maxGoalRounds } : {}),
      }),
    }
  },
})

const taskTools = (store) => {
  const openBoard = async () => {
    const board = await store.read()
    if (!Array.isArray(board.tasks)) board.tasks = []
    if (!Array.isArray(board.archived)) board.archived = []
    return board
  }
  const depDone = (board, id) => {
    const dep = board.tasks.find((t) => t.id === id)
    return Boolean(dep && dep.status === 'done')
  }
  /**
   * acceptance 契约（2026-11-05 定：唯一一种可执行形态）
   *   {check, passWhen, verify: {command, cwd}}
   * verify.command 由 cmd.exe /c（Windows）或 /bin/sh -c 执行，退出码 0 = 通过。
   * 没有 verify 的条目一律不可判定，转 done 时按未通过处理。
   */
  const ACCEPTANCE = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        check: { type: 'string', description: 'what this entry checks' },
        passWhen: { type: 'string', description: 'what counts as passing' },
        verify: {
          type: 'object',
          description: 'executable check; command exit code 0 = pass',
          properties: {
            command: { type: 'string', description: 'command line, run by cmd.exe /c on Windows' },
            cwd: { type: 'string', description: 'working directory for the command; required' },
          },
          required: ['command', 'cwd'],
          additionalProperties: false,
        },
      },
      required: ['check', 'passWhen', 'verify'],
      additionalProperties: false,
    },
  }
  const assertAcceptance = (acceptance) => {
    if (!Array.isArray(acceptance) || acceptance.length === 0)
      throw new Error('a task needs at least one acceptance entry')
    acceptance.forEach((entry, index) => {
      if (typeof entry?.check !== 'string' || typeof entry?.passWhen !== 'string')
        throw new Error(`acceptance[${index}] needs check and passWhen strings`)
      if (!entry?.verify?.command || !entry?.verify?.cwd)
        throw new Error(`acceptance[${index}] needs verify.command and verify.cwd (exit code 0 = pass)`)
    })
  }
  const VERIFY_TIMEOUT_MS = 120000
  const depsReachable = (board, fromId, targetId, seen = new Set()) => {
    if (fromId === targetId) return true
    if (seen.has(fromId)) return false
    seen.add(fromId)
    const node = board.tasks.find((t) => t.id === fromId)
    if (!node) return false
    return node.deps.some((dep) => depsReachable(board, dep, targetId, seen))
  }
  const assertDeps = (board, task, deps) => {
    if (!Array.isArray(deps) || deps.some((dep) => typeof dep !== 'string'))
      throw new Error('deps must be an array of task ids')
    for (const dep of deps) {
      if (dep === task.id) throw new Error('a task cannot depend on itself')
      if (!board.tasks.some((t) => t.id === dep)) throw new Error(`unknown dependency: ${dep}`)
    }
    const previous = task.deps
    task.deps = deps
    const cyclic = deps.filter((dep) => depsReachable(board, dep, task.id))
    task.deps = previous
    if (cyclic.length > 0) throw new Error(`dependency cycle via: ${cyclic.join(', ')}`)
  }
  const runAcceptance = async (task) => {
    const results = []
    for (let index = 0; index < task.acceptance.length; index += 1) {
      const entry = task.acceptance[index]
      if (!entry?.verify?.command || !entry?.verify?.cwd) {
        results.push({ index, check: entry?.check ?? '', passed: false, exitCode: null, reason: 'missing verify.command/cwd' })
        continue
      }
      const startedAt = Date.now()
      let exitCode = 1
      let output = ''
      try {
        const run = await execFileAsync(shellOf(), shellArgsOf(entry.verify.command), {
          cwd: entry.verify.cwd,
          timeout: VERIFY_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        })
        exitCode = 0
        output = `${run.stdout ?? ''}${run.stderr ?? ''}`
      } catch (error) {
        exitCode = error?.killed ? 124 : typeof error?.code === 'number' ? error.code : 1
        output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`
      }
      results.push({
        index,
        check: entry.check,
        command: entry.verify.command,
        exitCode,
        passed: exitCode === 0,
        tail: String(output).slice(-600),
        ms: Date.now() - startedAt,
      })
    }
    return results
  }

  const shortOf = (task) => ({
    id: task.id,
    title: task.title,
    kind: task.kind,
    group: task.group,
    owner: task.owner,
    status: task.status,
    deps: task.deps,
    revision: task.revision,
  })

  return [
    {
      name: 'bf_manifest_add',
      description:
        'Create one task on the project-wide board. captain creates group nodes (kind=group); mate creates tasks inside a group. Owner, dependencies, outputs and acceptance are part of the record; a task without acceptance is rejected.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          kind: { type: 'string', enum: ['group', 'investigate', 'implement', 'verify', 'doc'] },
          group: { type: 'string', description: 'owning group; leave empty for a group node' },
          parent: { type: 'string', description: 'parent task id' },
          owner: { type: 'string', description: 'owner name; omit to leave unclaimed' },
          deps: { type: 'array', items: { type: 'string' }, description: 'dependency task ids' },
          outputs: { type: 'array', items: { type: 'string' }, description: 'artifact paths to deliver' },
          acceptance: ACCEPTANCE,
        },
        required: ['title', 'kind', 'acceptance'],
        additionalProperties: false,
      },
      output: resultShape(),
      async execute(args) {
        assertAcceptance(args.acceptance)
        return store.run(async () => {
          const board = await openBoard()
          const id = `t-${Date.now().toString(36)}-${(board.tasks.length + 1).toString(36)}`
          const task = {
            id,
            title: args.title,
            kind: args.kind,
            group: args.group ?? null,
            parent: args.parent ?? null,
            owner: args.owner ?? null,
            deps: args.deps ?? [],
            outputs: args.outputs ?? [],
            acceptance: args.acceptance,
            evidence: [],
            status: 'ready',
            revision: 1,
            blockedReason: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          board.tasks.push(task)
          board.rev = (board.rev ?? 0) + 1
          await store.write(board)
          return { ok: true, task }
        })
      },
    },
    {
      name: 'bf_manifest_claim',
      description:
        'Claim a ready task: set its owner and move it to running. A task with unfinished dependencies cannot be claimed.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          revision: { type: 'integer', description: 'current revision' },
          owner: { type: 'string', description: 'claimer name' },
        },
        required: ['id', 'revision', 'owner'],
        additionalProperties: false,
      },
      output: resultShape(),
      async execute(args) {
        return store.run(async () => {
          const board = await openBoard()
          const task = board.tasks.find((t) => t.id === args.id)
          if (!task) throw new Error(`unknown task: ${args.id}`)
          if (task.revision !== args.revision) throw new Error(`revision mismatch: ${task.revision}`)
          if (task.status !== 'ready') throw new Error(`task is ${task.status}, not claimable`)
          const unmet = task.deps.filter((d) => !depDone(board, d))
          if (unmet.length) throw new Error(`unfinished dependencies: ${unmet.join(', ')}`)
          task.owner = args.owner
          task.status = 'running'
          task.revision += 1
          task.updatedAt = Date.now()
          board.rev = (board.rev ?? 0) + 1
          await store.write(board)
          return { ok: true, task }
        })
      },
    },
    {
      name: 'bf_manifest_update',
      description:
        'Update one task by revision: change status, record a block reason, append evidence, replace acceptance, replace deps (ids must exist and stay acyclic). status=done first runs every acceptance verify.command and refuses the transition unless all exit 0.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          revision: { type: 'integer' },
          status: { type: 'string', enum: TASK_STATUS },
          blockedReason: { type: 'string' },
          note: { type: 'string' },
          acceptance: ACCEPTANCE,
          deps: { type: 'array', items: { type: 'string' }, description: 'replacement dependency task ids' },
          evidence: {
            type: 'object',
            description: 'one evidence entry: command, exit code, artifact',
            properties: {
              command: { type: 'string' },
              exitCode: { type: 'integer' },
              artifact: { type: 'string' },
            },
            required: ['command'],
          },
          owner: { type: 'string' },
        },
        required: ['id', 'revision'],
        additionalProperties: false,
      },
      output: resultShape(),
      async execute(args) {
        if (args.acceptance !== undefined) assertAcceptance(args.acceptance)
        return store.run(async () => {
          const board = await openBoard()
          const task = board.tasks.find((t) => t.id === args.id)
          if (!task) throw new Error(`unknown task: ${args.id}`)
          if (task.revision !== args.revision) throw new Error(`revision mismatch: ${task.revision}`)
          if (args.acceptance !== undefined) task.acceptance = args.acceptance
          if (args.deps !== undefined) {
            assertDeps(board, task, args.deps)
            task.deps = args.deps
          }
          if (args.status) {
            if (!TASK_STATUS.includes(args.status)) throw new Error(`invalid status: ${args.status}`)
            if (args.status === 'failed' && !args.note)
              throw new Error('failed requires note: which condition changes next time')
            if (args.status === 'blocked' && !args.blockedReason)
              throw new Error('blocked requires blockedReason: whom or what it waits for')
            if (args.status === 'done') {
              const results = await runAcceptance(task)
              task.verification = { at: Date.now(), results }
              const failed = results.filter((entry) => !entry.passed)
              if (failed.length > 0) {
                task.revision += 1
                task.updatedAt = Date.now()
                board.rev = (board.rev ?? 0) + 1
                await store.write(board)
                const lines = failed.map(
                  (entry) => `#${entry.index} exit=${entry.exitCode} ${entry.reason ?? entry.command}`,
                )
                throw new Error(`acceptance not met (${failed.length}/${results.length}): ${lines.join(' | ')}`)
              }
              for (const entry of results)
                task.evidence.push({
                  command: `${entry.check} → ${entry.command}`,
                  exitCode: entry.exitCode,
                  artifact: '',
                  at: Date.now(),
                })
            }
            task.status = args.status
            task.blockedReason = args.status === 'blocked' ? args.blockedReason : null
          }
          if (args.owner) task.owner = args.owner
          if (args.evidence) task.evidence.push({ ...args.evidence, at: Date.now() })
          task.revision += 1
          task.updatedAt = Date.now()
          board.rev = (board.rev ?? 0) + 1
          await store.write(board)
          return { ok: true, task }
        })
      },
    },
    {
      name: 'bf_manifest_list',
      description:
        'Read the board: filter by group, status, owner; ready=true keeps only ready tasks whose dependencies are done. archived=true reads retired tasks instead of the live board.',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string' },
          status: { type: 'string', enum: TASK_STATUS },
          owner: { type: 'string' },
          ready: { type: 'boolean' },
          archived: { type: 'boolean', description: 'read retired tasks instead of the live board' },
          full: { type: 'boolean', description: 'return full records including acceptance and evidence' },
        },
        additionalProperties: false,
      },
      output: resultShape(),
      async execute(args) {
        const board = await openBoard()
        if (args.archived === true) {
          const rows = board.archived
          return { ok: true, total: rows.length, archived: args.full ? rows : rows.map(shortOf) }
        }
        let rows = board.tasks
        if (args.group) rows = rows.filter((t) => t.group === args.group)
        if (args.status) rows = rows.filter((t) => t.status === args.status)
        if (args.owner) rows = rows.filter((t) => t.owner === args.owner)
        if (args.ready)
          rows = rows.filter((t) => t.status === 'ready' && t.deps.every((d) => depDone(board, d)))
        return { ok: true, total: rows.length, tasks: args.full ? rows : rows.map(shortOf) }
      },
    },
    {
      name: 'bf_manifest_archive',
      description:
        'Retire one task from the live board into the archive — the only supported way to remove a task. Refuses while other tasks still name it as their group or dependency.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          revision: { type: 'integer', description: 'current revision' },
          reason: { type: 'string', description: 'why this task is retired' },
        },
        required: ['id', 'revision'],
        additionalProperties: false,
      },
      output: resultShape(),
      async execute(args) {
        return store.run(async () => {
          const board = await openBoard()
          const index = board.tasks.findIndex((t) => t.id === args.id)
          if (index < 0) throw new Error(`unknown task: ${args.id}`)
          const task = board.tasks[index]
          if (task.revision !== args.revision) throw new Error(`revision mismatch: ${task.revision}`)
          const children = board.tasks.filter((t) => t.group === task.id).map((t) => t.id)
          if (children.length > 0) throw new Error(`task still owns: ${children.join(', ')}`)
          const dependents = board.tasks
            .filter((t) => t.id !== task.id && t.deps.includes(task.id))
            .map((t) => t.id)
          if (dependents.length > 0) throw new Error(`task is still a dependency of: ${dependents.join(', ')}`)
          const record = {
            ...task,
            revision: task.revision + 1,
            archivedAt: Date.now(),
            archiveReason: args.reason ?? null,
          }
          board.tasks.splice(index, 1)
          board.archived.push(record)
          board.rev = (board.rev ?? 0) + 1
          await store.write(board)
          return { ok: true, archived: record, remaining: board.tasks.length }
        })
      },
    },
  ]
}

const publicTools = (config, store, storePath) => {
  const settings = () => ({
    sessionsRoot: config?.publicInfo?.sessionsRoot ?? SESSIONS_ROOT,
    projectRoot: config?.publicInfo?.projectRoot ?? PROJECT_ROOT,
  })
  const exists = async (path) => {
    try {
      await fs.stat(path)
      return true
    } catch {
      return false
    }
  }
  const sessionLog = async (sessionId) => {
    const root = settings().sessionsRoot
    const buckets = await fs.readdir(root, { withFileTypes: true })
    const hits = []
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue
      const candidate = `${root}/${bucket.name}/${sessionId}/session.v4.jsonl.zstd`
      if (await exists(candidate)) hits.push(candidate)
    }
    if (hits.length === 0) throw new Error(`no session log for ${sessionId} under ${root}`)
    if (hits.length > 1) throw new Error(`session ${sessionId} matched ${hits.length} logs: ${hits.join(', ')}`)
    return hits[0]
  }
  const countStatuses = (node, counts = {}) => {
    if (Array.isArray(node)) {
      for (const item of node) countStatuses(item, counts)
      return counts
    }
    if (!node || typeof node !== 'object') return counts
    if (typeof node.status === 'string') counts[node.status] = (counts[node.status] ?? 0) + 1
    for (const value of Object.values(node)) if (value && typeof value === 'object') countStatuses(value, counts)
    return counts
  }
  const indexSummary = async (path) => {
    const json = JSON.parse(await fs.readFile(path, 'utf8'))
    return {
      file: path,
      updated: json?.updated ?? null,
      project: json?.project ?? null,
      statusCounts: countStatuses(json),
    }
  }
  const projectProgress = async () => {
    const root = settings().projectRoot
    const state = await fs.readFile(`${root}/docs/STATE.md`, 'utf8')
    const progressLog = await fs.readFile(`${root}/docs/PROGRESS.md`, 'utf8')
    const board = await store.read()
    const tasks = Array.isArray(board.tasks) ? board.tasks : []
    const byStatus = {}
    for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
    return {
      projectRoot: root,
      state,
      progressTail: progressLog.split('\n').slice(-40).join('\n'),
      index: {
        design: await indexSummary(`${root}/docs/design/index.json`),
        information: await indexSummary(`${root}/docs/information/index.json`),
      },
      board: {
        storePath,
        total: tasks.length,
        byStatus,
        archived: (board.archived ?? []).length,
      },
    }
  }
  return [
    {
      name: 'bf_brief',
      description:
        'Read-only public information in one entry. kind=session: on-disk log path of a session (default the caller). kind=progress: docs/STATE.md, the last 40 lines of docs/PROGRESS.md, both index.json status counts, and live board counts.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['session', 'progress'] },
          sessionId: { type: 'string', description: 'kind=session only; omit for the calling session' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      output: resultShape(),
      async execute(args, exec) {
        if (args.kind === 'session') {
          const sessionId = args.sessionId ?? exec.agent?.id
          if (!sessionId) throw new Error('no session id available: pass sessionId')
          return { ok: true, kind: 'session', sessionId, path: await sessionLog(sessionId) }
        }
        if (args.kind === 'progress') return { ok: true, kind: 'progress', ...(await projectProgress()) }
        throw new Error(`unknown kind: ${String(args.kind)}`)
      },
    },
  ]
}

export function apply(ctx, config) {
  const storePath = config?.storePath ?? BOARD_PATH
  const store = createStore(storePath)
  if (config?.goals?.enabled !== false) {
    ctx.effect(() => ctx.tools.register(goalTool(ctx)))
  }
  if (config?.dispatchGoal?.enabled !== false) {
    ctx.effect(() => ctx.tools.register(goalDispatchTool(ctx)))
  }
  if (config?.tasks?.enabled !== false) {
    for (const tool of taskTools(store)) {
      ctx.effect(() => ctx.tools.register(tool))
    }
  }
  if (config?.publicInfo?.enabled) {
    for (const tool of publicTools(config, store, storePath)) {
      ctx.effect(() => ctx.tools.register(tool))
    }
  }
  if (config?.roles?.enabled !== false) {
    installRoleHooks(ctx, config?.roles ?? {})
  }
  if (config?.foldTitles?.enabled !== false) {
    installFoldTitles(ctx, config?.foldTitles ?? {})
  }
  if (config?.goalRearm?.enabled !== false) {
    installGoalRearm(ctx, config?.goalRearm ?? {})
  }
  installHookForms(ctx)
}
