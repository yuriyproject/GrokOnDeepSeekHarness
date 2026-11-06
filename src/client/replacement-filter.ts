/** Generation-scoped suppression of the blank-session replacement "removed" frame. */

export const REPLACEMENT_TIMEOUT_MS = 10_000

export interface ReplacementTrackerOptions {
  timeoutMs?: number
  schedule: (fn: () => void, ms: number) => () => void
}

interface ReplacementRecord {
  generation: number
  replay?: () => void
  cancelTimer: () => void
}

/** Track one harness switch at a time per session id. */
export function createReplacementTracker(options: ReplacementTrackerOptions) {
  const timeoutMs = options.timeoutMs ?? REPLACEMENT_TIMEOUT_MS
  let generation = 0
  const sessions = new Map<string, ReplacementRecord>()

  const clear = (sessionId: string, rec: ReplacementRecord): void => {
    rec.cancelTimer()
    if (sessions.get(sessionId) === rec) sessions.delete(sessionId)
  }

  return {
    begin(sessionId: string): number {
      const previous = sessions.get(sessionId)
      previous?.cancelTimer()
      const current = ++generation
      const rec: ReplacementRecord = {
        generation: current,
        cancelTimer: () => undefined,
      }
      rec.cancelTimer = options.schedule(() => {
        if (sessions.get(sessionId) !== rec) return
        const replay = rec.replay
        sessions.delete(sessionId)
        replay?.()
      }, timeoutMs)
      sessions.set(sessionId, rec)
      return current
    },

    shouldSuppressRemoval(sessionId: string): boolean {
      return sessions.has(sessionId)
    },

    noteRemoval(sessionId: string, replay: () => void): boolean {
      const rec = sessions.get(sessionId)
      if (rec === undefined) return false
      rec.replay = replay
      return true
    },

    noteAdded(sessionId: string, agentAvailable: boolean): void {
      if (agentAvailable !== true) return
      const rec = sessions.get(sessionId)
      if (rec === undefined) return
      clear(sessionId, rec)
    },
  }
}

export type ReplacementTracker = ReturnType<typeof createReplacementTracker>
