import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HarnessRouterFactory } from '../lib/router.js'

function session() {
  const events = []
  return {
    id: 'sess-1',
    header: {},
    events,
    append(type, data) {
      events.push({ type, data })
      return { seq: events.length }
    },
    snapshotEvents() {
      return events
    },
  }
}

function underlying(label) {
  const live = session()
  let disposed = false
  return {
    label,
    get disposed() {
      return disposed
    },
    agent: { session: live, status: 'idle' },
    async dispose() {
      disposed = true
    },
  }
}

function ctx() {
  return {
    logger: { error() {} },
    on() {},
    get(name) {
      return this[name]
    },
    agents: {
      turnBoundaryOf() {
        return { openTurnStartSeq: null, lastTurn: 0 }
      },
    },
    agentPresets: {
      defaultId: 'standard',
      async mount() {},
      presetForSession() {
        return undefined
      },
    },
  }
}

function factories({ grokResume, dshResume }) {
  const grok = {
    host: { async ensureProcess() {} },
    async createAgent() {
      return underlying('grok-create')
    },
    async resume() {
      return grokResume()
    },
    async dispose() {},
  }
  const dsh = {
    async createAgent() {
      return underlying('dsh-create')
    },
    async resume(ownerCtx, options) {
      await options.setup?.({ on() { return () => {} } })
      return dshResume()
    },
  }
  return { grok, dsh }
}

describe('HarnessRouterFactory.switchBlank', () => {
  it('falls back to DSH when the Grok resume fails and keeps a live record', async () => {
    const hostCtx = ctx()
    const { grok, dsh } = factories({
      grokResume: async () => { throw new Error('grok down') },
      dshResume: async () => underlying('dsh-fallback'),
    })
    const router = new HarnessRouterFactory(hostCtx, dsh, grok)
    const record = {
      ownerCtx: {},
      sessionId: 'sess-1',
      agentOptions: {},
      mode: 'dsh',
      underlying: underlying('original'),
      transition: Promise.resolve(),
      disposed: false,
    }
    router.records.set('sess-1', record)
    await assert.rejects(() => router.switchBlank(record, 'grok-build', 'grok-build'), /grok down/)
    assert.equal(record.disposed, false)
    assert.equal(record.mode, 'dsh')
    assert.equal(record.underlying.label, 'dsh-fallback')
    assert.equal(router.records.get('sess-1'), record)
  })

  it('marks the record disposed when Grok resume and DSH fallback both fail', async () => {
    const hostCtx = ctx()
    const { grok, dsh } = factories({
      grokResume: async () => { throw new Error('grok down') },
      dshResume: async () => { throw new Error('dsh down') },
    })
    const router = new HarnessRouterFactory(hostCtx, dsh, grok)
    const original = underlying('original')
    const record = {
      ownerCtx: {},
      sessionId: 'sess-1',
      agentOptions: {},
      mode: 'dsh',
      underlying: original,
      transition: Promise.resolve(),
      disposed: false,
    }
    router.records.set('sess-1', record)
    await assert.rejects(
      () => router.switchBlank(record, 'grok-build', 'grok-build'),
      /DSH fallback failed|dsh down/,
    )
    assert.equal(record.disposed, true)
    assert.equal(original.disposed, true)
    assert.equal(router.records.has('sess-1'), false)
  })
})
