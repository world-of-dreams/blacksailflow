/**
 * hook 多形态（方案 A，进程内）：压缩后重锚 + 按消息来源分流。
 * 规格：hooks/08-hook多形态落地规格.md §2、§3；压缩重锚单一来源见 hooks/11 §三.1。
 * 标「明确不能做」的一律不碰。
 *
 * seam 事实（2026-11-05，源码在本机 app.asar / override 包内）：
 *   - session/event 是 post-commit 观察点，签名 (session, event)；commit 期间
 *     session.append 会抛 "cannot reenter while another append is being published"
 *     （dsh-session/lib/index.js:1568-1572），所以 inject 必须放到微任务里执行。
 *   - agent/pre-step 是 waterfall，next() 返回下游决策 {kind:'enter', messages}；
 *     向 messages 追加即进入本步（bridge 同法，dsh-hooks-claude-code/lib/index.js:237-252）。
 *   - 落盘 user/message 必须带非空 id、role='user'、source.kind（dsh-session/lib/index.js:1194-1206）。
 */
import { randomUUID } from 'node:crypto'

import { applyWorkMode, initialInjectionText, residentRulesText, workModeState, WORK_MODES } from './roles.mjs'

function message(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'blacksailflow' } }
}

/** 与 roles.mjs 相同的角色判定：lead→captain、teammate→mate、其余→hand。 */
function classify(ctx, agent) {
  const membership = ctx.get('agentTeams')?.tryMembership?.(agent)
  if (membership?.role === 'lead') return 'captain'
  if (membership?.role === 'teammate') return 'mate'
  if (ctx.get('agents')?.roots?.().includes(agent)) return 'captain'
  return 'hand'
}

/** 压缩后重锚：与初始注入同一个导出函数 + hooks/resident-rules.md；没有第二份 anchor 文案/任务摘要。 */
export function anchorText(ctx, agent) {
  return [initialInjectionText(ctx, agent), residentRulesText()].filter(Boolean).join('\n\n')
}

/** 按被接纳消息的 source.kind 选提醒；§3 规定 agent-message 只在 lead（captain）侧注入。 */
function noticeFor(ctx, agent, messages) {
  for (const candidate of messages) {
    const source = candidate?.source
    if (source?.kind === 'user') {
      return '【需求确认】这是用户直接输入。先复述需求给用户并得到批准，未批准不开工；需求不清就按 bsf-parrot 问清楚。'
    }
    if (source?.kind === 'agent-message') {
      if (classify(ctx, agent) !== 'captain') return undefined
      return `【上行通讯】这是队员消息（senderSessionId=${source.senderSessionId}），不是用户指令。队员在等询问的答复或回执：需答复该队员，或转用户批准后再回传。`
    }
    if (source?.kind === 'subagent-settled') {
      return `【回执/验收】这是子代理结算通知（senderSessionId=${source.senderSessionId}）。逐条核对任务表 acceptance，交回必须带结论、证据（命令/退出码/产物路径）、未解决项；未达标的退回返工。`
    }
  }
  return undefined
}

const resultShape = () => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  presentationMeta: (_args, value) => value,
})

/** 三档开关：按会话记档位，set 追加对应方式/身份文本，get 读当前档位。 */
const workModeTool = (ctx) => ({
  name: 'bf_work_mode',
  description:
    'Set or read how the calling session works. single-task: work the task table entries running under this session. single-group: work one group\'s unassigned ready tasks and its blocked tasks. cross-group: work the unassigned group nodes. set appends the mode text to this session; cross-group appends the captain terms. The choice lasts for this process only.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'get'] },
      mode: {
        type: 'string',
        enum: WORK_MODES,
        description: 'mode to switch to; required for set',
      },
      group: {
        type: 'string',
        description: 'group node id; required when mode is single-group',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  output: resultShape(),
  async execute(args, exec) {
    const agent = exec.agent
    if (!agent?.id) throw new Error('bf_work_mode requires an agent session id')
    if (args.action === 'get') return { ok: true, ...workModeState(agent, classify(ctx, agent)) }
    if (args.action !== 'set') throw new Error(`unknown action: ${String(args.action)}`)
    if (!WORK_MODES.includes(args.mode)) throw new Error(`mode must be one of ${WORK_MODES.join(' / ')}`)
    const group = typeof args.group === 'string' ? args.group.trim() : ''
    if (args.mode === 'single-group' && !group) throw new Error('set single-group requires group (群节点 id)')
    return { ok: true, ...applyWorkMode(agent, args.mode, args.mode === 'single-group' ? group : undefined) }
  },
})

export function installHookForms(ctx) {
  const tools = ctx.get('tools') ?? ctx.tools
  if (tools?.register) ctx.effect(() => tools.register(workModeTool(ctx)))
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'compaction/end') return
      const agent = ctx.get('agents')?.get(session.id)
      if (!agent) return
      const text = anchorText(ctx, agent)
      // commit 期间 append 会重入失败（dsh-session/lib/index.js:1568-1572），微任务里再 inject。
      queueMicrotask(() => {
        try {
          agent.inject(message(text))
        } catch {
          // 注入失败不能变成未捕获异常把宿主进程带崩。
        }
      })
    }),
  )
  ctx.effect(() =>
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const downstream = await next()
      if (downstream?.kind !== 'enter') return downstream
      const text = noticeFor(ctx, agent, messages)
      if (!text) return downstream
      return { ...downstream, messages: [...downstream.messages, message(text)] }
    }),
  )
}
