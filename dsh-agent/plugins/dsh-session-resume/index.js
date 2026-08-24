/**
 * Resume a persisted session instead of failing on it.
 *
 * `dsh-sdk-jsonrpc-server` only ever calls `ctx.agents.create()`
 * (packages/sdk/server/src/server.ts). Prompting a session id whose log is
 * already on disk therefore ends the turn with
 *
 *   session "<id>" already has a persisted log on disk; load/resume it instead
 *   of creating                    (session-persistence/coordinator.ts)
 *
 * and the prompt is dropped. `ctx.agents.resume()` is the call that path wants
 * — it is what the Web host uses — so this wraps `create()` and routes a known
 * id there. Wrapping the registry rather than forking the SDK server keeps this
 * independent of that package's version, and covers any other transport
 * (ACP, headless) that creates by caller-supplied id.
 *
 * ponytail: existence comes from a `list()` scan of the session root, one call
 * per new session in the process. Past a few thousand sessions per DSH_HOME,
 * swap it for a direct `inspect(id)` probe.
 */

export const name = 'session-resume'
export const inject = ['agents', 'sessionPersistence']

export function apply(ctx) {
  const agents = ctx.agents
  const create = agents.create

  async function createOrResume(options) {
    const header = (await ctx.sessionPersistence.list())
      .find(entry => entry.id === options.sessionId)
    if (header === undefined) return create.call(agents, options)

    // The session id arrives from an out-of-process caller. A persisted session
    // carries its own immutable cwd, so resuming one recorded under another
    // workspace would hand this caller a different project's history.
    const wanted = options.meta?.cwd
    if (wanted !== undefined && header.cwd !== wanted) {
      throw new Error(
        `session "${options.sessionId}" is persisted under ${header.cwd ?? '(no cwd)'}, not ${wanted}`,
      )
    }

    return agents.resume({
      resumeSessionId: options.sessionId,
      ...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions },
      ...options.setup === undefined ? {} : { setup: options.setup },
    })
  }

  agents.create = createOrResume
  ctx.effect(() => () => {
    if (agents.create === createOrResume) delete agents.create
  }, 'session-resume: restore ctx.agents.create')
}
