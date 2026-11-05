/**
 * Small helpers over the DeepSeek Harness runtime.
 *
 * DSH 0.2.x routes every `@deepseek-ai/*` import issued from a profile plugin
 * to the copies carried by the running installation (see
 * `@deepseek-ai/dsh-app-boot` "runtime interception"), so this package can
 * import its peers statically. Outside DSH (unit tests) the same specifiers
 * resolve to the pinned devDependencies.
 */

export const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/** Strip the Cordis service proxy so plain fields (such as a slot) can be reassigned. */
export function unwrapService(service) {
  return service?.[CORDIS_ORIGINAL] ?? service
}

/** Read the session log across DSH Session API generations. */
export function sessionEvents(session) {
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
  if (Array.isArray(session?.events)) return session.events
  return []
}

/** Count of inherited (seeded) events that precede this session's own log. */
export function inheritedEventCount(session) {
  return session?.inheritedEventCount ?? 0
}

/** Fold the agent preset a cold event log selected, falling back to the header. */
export function presetOfEvents(events, header) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
      return event.data.agentPreset
    }
  }
  return header?.agentPreset
}

/** Whether no turn has started yet, by the predicate the preset registry's `select` enforces. */
export function sessionBlank(ctx, session) {
  const registry = ctx?.agents
  if (registry !== undefined && typeof registry.turnBoundaryOf === 'function') {
    const boundary = registry.turnBoundaryOf(session)
    return boundary.openTurnStartSeq === null && boundary.lastTurn === 0
  }
  return !sessionEvents(session).some(event => event.type === 'turn/start')
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
