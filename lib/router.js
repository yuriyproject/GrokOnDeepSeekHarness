/** Preset-aware multiplexer over the official DSH AgentLoop and Grok ACP. */

import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { DEFAULT_DSH_PRESET, GROK_PRESET_ID, isGrokPreset } from './constants.js'
import { presetOfEvents, sessionBlank } from './dsh.js'

export class HarnessRouterFactory {
  constructor(ctx, dshFactory, grokFactory) {
    this.ctx = ctx
    this.dshFactory = dshFactory
    this.grokFactory = grokFactory
    this.records = new Map()
    this.lastDshPreset = new Map()
    this.disposed = false
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'agent-preset/selected') return
      this.observePreset(String(session.id), event.data?.agentPreset)
    })
  }

  /** React to a preset selection on a tracked session: queue a harness switch when the engine changes. */
  observePreset(key, agentPreset) {
    if (typeof agentPreset !== 'string') return
    const record = this.records.get(key)
    if (!isGrokPreset(agentPreset)) this.lastDshPreset.set(key, agentPreset)
    if (record === undefined) return
    const target = this.modeForPreset(agentPreset)
    if (target === record.mode) return
    record.transition = record.transition.then(
      () => this.switchBlank(record, target, agentPreset),
      () => this.switchBlank(record, target, agentPreset),
    )
    void record.transition.catch(error => {
      this.ctx.logger.error(`dsh-grok-acp: failed to switch session ${key}: ${errorChain(error)}`)
    })
  }

  modeForPreset(preset) {
    return isGrokPreset(preset) ? GROK_PRESET_ID : 'dsh'
  }

  factoryFor(mode) {
    return mode === GROK_PRESET_ID ? this.grokFactory : this.dshFactory
  }

  lastDsh(sessionId) {
    const remembered = this.lastDshPreset.get(String(sessionId))
    if (remembered !== undefined) return remembered
    const defaultId = this.ctx.get('agentPresets')?.defaultId
    return typeof defaultId === 'string' && !isGrokPreset(defaultId) ? defaultId : DEFAULT_DSH_PRESET
  }

  /** The preset a live session currently uses, by the registry projection. */
  presetOf(session) {
    const presets = this.ctx.get('agentPresets')
    const projected = presets?.presetForSession?.(session)
    if (typeof projected === 'string') return projected
    return session.header?.agentPreset
  }

  async createAgent(ownerCtx, options) {
    const preset = options.meta?.agentPreset
    const mode = this.modeForPreset(preset)
    if (preset !== undefined && !isGrokPreset(preset)) this.lastDshPreset.set(String(options.sessionId), preset)
    const underlying = await this.factoryFor(mode).createAgent(ownerCtx, options)
    return this.track(ownerCtx, options.sessionId, options.agentOptions ?? {}, mode, underlying)
  }

  async resume(ownerCtx, options) {
    const preset = await this.coldPreset(options.resumeSessionId, options.signal)
    const mode = this.modeForPreset(preset)
    if (preset !== undefined && !isGrokPreset(preset)) this.lastDshPreset.set(String(options.resumeSessionId), preset)
    const underlying = await this.factoryFor(mode).resume(ownerCtx, options)
    return this.track(ownerCtx, options.resumeSessionId, options.agentOptions ?? {}, mode, underlying)
  }

  /** Read the selected preset from the stored log without taking write ownership. */
  async coldPreset(sessionId, signal) {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const handle = await persistence.open(sessionId, 'read', signal === undefined ? {} : { signal })
    try {
      const { events } = await handle.read(0, undefined, signal === undefined ? {} : { signal })
      return presetOfEvents(events, handle.header)
    } finally {
      await handle.close().catch(() => {})
    }
  }

  track(ownerCtx, sessionId, agentOptions, mode, underlying) {
    const key = String(sessionId)
    const record = {
      ownerCtx,
      sessionId,
      agentOptions,
      mode,
      underlying,
      transition: Promise.resolve(),
      disposed: false,
    }
    if (this.records.has(key)) throw new Error(`harness router already tracks session ${key}`)
    this.records.set(key, record)
    const dispose = async () => {
      if (record.disposed) return
      record.disposed = true
      await record.transition.catch(() => {})
      await record.underlying.dispose()
      this.records.delete(key)
    }
    // A setup callback may have re-selected the preset before publication.
    const selected = this.presetOf(record.underlying.agent.session)
    if (selected !== undefined && this.modeForPreset(selected) !== mode) {
      queueMicrotask(() => this.observePreset(key, selected))
    }
    return {
      get agent() { return record.underlying.agent },
      dispose,
    }
  }

  async switchBlank(record, mode, preset) {
    if (record.disposed || this.disposed || record.mode === mode) return
    if (!sessionBlank(this.ctx, record.underlying.agent.session)) {
      throw new Error(`cannot switch a started session from ${record.mode} to ${mode}`)
    }
    if (mode === GROK_PRESET_ID) {
      await this.grokFactory.host.ensureProcess()
    }
    await record.underlying.dispose()
    // resume() re-acquires the persisted session under the same id, so the
    // replacement agent continues the existing log instead of minting a new identity.
    const spawn = async (target, mountPreset) => this.factoryFor(target).resume(record.ownerCtx, {
      resumeSessionId: record.sessionId,
      agentOptions: record.agentOptions,
      setup: async (agentCtx) => {
        if (target === 'dsh') installModelSelection(agentCtx)
        await this.ctx.agentPresets.mount(agentCtx, mountPreset)
      },
    })
    try {
      record.underlying = await spawn(mode, preset)
      record.mode = mode
    } catch (error) {
      const fallback = this.lastDsh(record.sessionId)
      record.underlying = await spawn('dsh', fallback)
      record.mode = 'dsh'
      try {
        record.underlying.agent.session.append('agent-preset/selected', { agentPreset: fallback })
      } catch {
        // Best effort: the log keeps the failed preset if the session cannot accept writes yet.
      }
      throw error
    }
  }

  recordFor(sessionId) {
    return this.records.get(String(sessionId))
  }

  async dispose() {
    this.disposed = true
    await Promise.all([...this.records.values()].map(async record => {
      record.disposed = true
      await record.transition.catch(() => {})
      await record.underlying.dispose()
    }))
    this.records.clear()
    await this.grokFactory.dispose()
  }
}
