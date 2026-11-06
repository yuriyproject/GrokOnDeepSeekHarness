/**
 * Grok session id stored inside the DSH session log.
 *
 * The JSON map in `<DSH_HOME>/grok-harness-sessions.json` stays the primary link.
 * This record is only a fallback when that file has no entry. DSH writes it with
 * `appendPluginRecord`, which marks the event `ignorable`, so a harness that does
 * not know the type still opens the session.
 */

export const GROK_LINK_TYPE = 'plugin:dsh-grok-acp/session'

/** Record passed to `appendPluginRecord` for one Grok session id. */
export function linkRecord(remoteSessionId) {
  if (typeof remoteSessionId !== 'string' || remoteSessionId.length === 0) {
    throw new Error('Grok session id must be a non-empty string')
  }
  return {
    type: GROK_LINK_TYPE,
    data: { grokSessionId: remoteSessionId },
  }
}

/**
 * Newest Grok session id recorded in a DSH event log.
 * @param {readonly unknown[]} events Stored or live session events.
 * @returns {string | undefined}
 */
export function grokIdFromEvents(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== GROK_LINK_TYPE || event.ignorable !== true) continue
    const id = event.data?.grokSessionId
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}

/**
 * JSON mapping first, then the session log.
 * @param {string | undefined} mapped Entry from the JSON map.
 * @param {readonly unknown[]} events Stored session events.
 * @returns {string | undefined}
 */
export function preferMappedGrokId(mapped, events) {
  if (typeof mapped === 'string' && mapped.length > 0) return mapped
  return grokIdFromEvents(events)
}
