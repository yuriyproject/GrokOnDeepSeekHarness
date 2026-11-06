import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GrokInbox } from '../lib/inbox.js'
import { GrokWebAgent } from '../lib/grok-agent.js'

async function waitFor(condition, description, timeoutMs = 1000) {
  const start = Date.now()
  while (true) {
    const result = condition()
    if (result) return result
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

function message(id, text) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function rig() {
  const events = []
  const session = {
    header: { cwd: 'C:/work' },
    events,
    append(type, data, options) {
      const event = { type, data, options, seq: events.length }
      events.push(event)
      return event
    },
    snapshotEvents() {
      return events
    },
  }
  const prompts = []
  const cancels = []
  const host = {
    capabilities: {},
    async ensureAgentSession() {
      return 'remote-1'
    },
    prompt(params) {
      const pending = deferred()
      pending.params = params
      prompts.push(pending)
      return pending.promise
    },
    async cancel(params) {
      cancels.push(params)
      const inflight = prompts.find(item => item.settled !== true)
      if (inflight !== undefined) {
        inflight.settled = true
        inflight.resolve({ stopReason: 'cancelled' })
      }
    },
  }
  const agent = Object.create(GrokWebAgent.prototype)
  Object.assign(agent, {
    id: 'local-1',
    session,
    inbox: new GrokInbox(session, {
      inserted() {},
      discarded() {},
      claimed() {},
    }),
    dispatch: { emit() {} },
    hostCtx: { logger: { warn() {} } },
    host,
    remoteSessionId: 'remote-1',
    grokModel: 'grok-4.7',
    grokEffort: undefined,
    lastTurn: 0,
    phase: { kind: 'idle' },
    idle: Promise.resolve(),
    contextLost: false,
    turnApprovals: 0,
    streamRevision: 0,
    attemptCounter: 0,
    active: undefined,
    promptAbortGraceMs: 20,
  })
  return { agent, session, events, prompts, cancels, host }
}

describe('GrokWebAgent.steer', () => {
  it('cancels an in-flight turn as aborted user and starts the next turn with the steered text', async () => {
    const t = rig()
    t.agent.followup(message('m1', 'first'))
    await waitFor(() => t.prompts.length === 1, 'first Grok prompt')
    t.agent.steer(message('m2', 'steered'))
    await waitFor(() => t.cancels.length === 1, 'ACP session/cancel')
    await waitFor(() => t.events.some(event => event.type === 'turn/end'), 'first turn end')
    const firstEnd = t.events.find(event => event.type === 'turn/end')
    assert.deepEqual(firstEnd.data.reason, { kind: 'aborted', reason: { kind: 'user' } })
    await waitFor(() => t.prompts.length === 2, 'steered Grok prompt')
    assert.equal(t.prompts[0].params.prompt.some(block => block.text === 'first'), true)
    assert.equal(t.prompts[1].params.prompt.some(block => block.text === 'steered'), true)
    t.prompts[1].settled = true
    t.prompts[1].resolve({ stopReason: 'end_turn' })
    await t.agent.whenIdle()
    const ends = t.events.filter(event => event.type === 'turn/end')
    assert.equal(ends.length, 2)
    assert.deepEqual(ends[1].data.reason, { kind: 'completed' })
    const users = t.events.filter(event => event.type === 'user/message')
    assert.equal(users[0].data.content[0].text, 'first')
    assert.equal(users[1].data.content[0].text, 'steered')
  })

  it('behaves like followup when the agent is idle', async () => {
    const t = rig()
    t.agent.steer(message('m1', 'hello'))
    await waitFor(() => t.prompts.length === 1, 'idle steer prompt')
    assert.equal(t.cancels.length, 0)
    t.prompts[0].settled = true
    t.prompts[0].resolve({ stopReason: 'end_turn' })
    await t.agent.whenIdle()
    const end = t.events.find(event => event.type === 'turn/end')
    assert.deepEqual(end.data.reason, { kind: 'completed' })
    assert.equal(t.events.find(event => event.type === 'user/message').data.content[0].text, 'hello')
  })

  it('sends inline images when Grok advertised promptCapabilities.image', async () => {
    const t = rig()
    t.host.capabilities = { promptCapabilities: { image: true } }
    t.agent.followup({
      id: 'img-1',
      role: 'user',
      content: [{ type: 'image', mimeType: 'image/png', data: 'abcd' }],
      source: { kind: 'user' },
    })
    await waitFor(() => t.prompts.length === 1, 'image prompt')
    assert.deepEqual(t.prompts[0].params.prompt, [{ type: 'image', data: 'abcd', mimeType: 'image/png' }])
    t.prompts[0].settled = true
    t.prompts[0].resolve({ stopReason: 'end_turn' })
    await t.agent.whenIdle()
  })

  it('leaves inject as a next-step enqueue that does not cancel the turn', async () => {
    const t = rig()
    t.agent.followup(message('m1', 'first'))
    await waitFor(() => t.prompts.length === 1, 'first Grok prompt')
    t.agent.inject(message('m2', 'context'))
    assert.equal(t.cancels.length, 0)
    assert.equal(t.prompts.length, 1)
    assert.equal(t.agent.inbox.nextStep.length, 1)
    t.prompts[0].settled = true
    t.prompts[0].resolve({ stopReason: 'end_turn' })
    await t.agent.whenIdle()
  })
})
