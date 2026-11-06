/**
 * 重启后 goal 续跑。
 *
 * 为什么需要：goal 的 armed/disarmed 是进程内状态，不落盘；每会话缓存新建与每次
 * `agent/created` 边界都会 disarm，即使回放出的 durable phase 是 active
 * （证据：app.asar:/dsh/node_modules/@deepseek-ai/dsh-goal/README.md:99）。所以宿主重启或
 * 会话被冷恢复后，active goal 会停在 disarmed，round driver 不再驱动，无人值守推进断掉。
 *
 * 规则：只恢复 active + disarmed + roundsStarted < maxGoalRounds 的 goal，用 goals.resume 重新 arm，
 * round driver 随后自己起轮。paused / blocked / complete 一律不动：那些 phase 是明确的停止决定
 * （用户 pause、轮数耗尽 block、完成 complete），不能替用户拉起；不是「每个 session start 无脑 rearm」。
 */
export function installGoalRearm(ctx, config = {}) {
  const tried = new Set()
  ctx.effect(() =>
    ctx.on('agent/status', ({ agent }) => {
      try {
        const goals = ctx.get('goals')
        if (!goals?.get || !goals?.resume) return
        const goal = goals.get(agent)
        if (!goal || goal.phase !== 'active' || goal.activation !== 'disarmed') return
        if (Number(goal.roundsStarted) >= Number(goal.maxGoalRounds)) return
        const key = `${goal.id}:${goal.revision}`
        if (tried.has(key)) return
        tried.add(key)
        goals.resume(agent, { id: goal.id, revision: goal.revision })
      } catch (error) {
        console.error('[blacksailflow] goal-rearm failed:', error)
      }
    }),
  )
}
