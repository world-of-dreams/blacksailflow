export const name = 'bsf-skill-shadow'
export const inject = ['skills']

export function apply(ctx, config) {
  const hidden = config?.hidden ?? []
  ctx.skills.registerProvider(() => ({
    name: 'bsf-skill-shadow',
    async list() {
      return {
        complete: true,
        candidates: hidden.map((name) => ({
          name,
          description: '',
          source: 'runtime',
          provider: 'bsf-skill-shadow',
          rank: 0,
          invocation: { modelInvocable: false, userInvocable: false },
        })),
      }
    },
    async get() {
      return undefined
    },
  }))
}
