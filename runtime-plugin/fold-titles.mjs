/**
 * Fold-title pass: when a hand (non-Team subagent) goes idle, rewrite its session title
 * to the last assistant text, so the parent's subagent tree row reads "task · result".
 */

const FOLD_MAX_CHARS = 100

/** Last assistant text of a session, whitespace-collapsed and capped; '' when there is none. */
const summaryOf = (agent) => {
  const events = agent?.session?.snapshotEvents?.() ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) return ''
    const text = content
      .filter((block) => block?.type === 'text')
      .map((block) => block.text ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) return ''
    return text.length > FOLD_MAX_CHARS ? `${text.slice(0, FOLD_MAX_CHARS)}…` : text
  }
  return ''
}

export function installFoldTitles(ctx, config = {}) {
  const handled = new Set()
  ctx.effect(() =>
    ctx.on('agent/status', ({ agent, status }) => {
      try {
        if (status !== 'idle') return
        if (agent?.session?.header?.origin !== 'subagent') return
        if (!agent.session.header.parentSession) return
        if (ctx.get('agentTeams')?.tryMembership?.(agent) !== undefined) return
        const title = ctx.get('sessionTitle')
        if (!title?.rename) return
        const key = agent.id
        if (handled.has(key)) return
        const summary = summaryOf(agent)
        if (!summary) return
        handled.add(key)
        try {
          title.rename(agent.session, summary)
        } catch {
          // 标题改写失败不向宿主抛。
        }
      } catch (error) {
        console.error('[blacksailflow] fold-titles failed:', error)
      }
    }),
  )
}
