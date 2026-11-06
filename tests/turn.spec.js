import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GrokWebAgent, TOOL_SETTLE_MS, createTurnState } from '../lib/grok-agent.js'

/**
 * Minimal mirror of the lifecycle rules DSH 0.2.x enforces on stored logs:
 * a tool/call must be advertised by an assistant tool-call block of the same
 * step, a step may only end with every tool resolved, and a turn may only end
 * with no open step.
 */
class RuleSession {
  events = []
  turn = null
  step = null
  tools = new Map()
  header = { cwd: 'C:/work' }

  append(type, data, options) {
    const event = { type, data, options, seq: this.events.length }
    this.check(event)
    this.events.push(event)
    return event
  }

  check({ type, data, options }) {
    switch (type) {
      case 'turn/start':
        assert.equal(this.turn, null, 'turn/start inside an open turn')
        this.turn = data.turn
        break
      case 'turn/end':
        assert.notEqual(this.turn, null)
        assert.equal(this.step, null, 'turn/end with an open step')
        assert.equal(this.tools.size, 0, 'turn/end with unresolved tools')
        this.turn = null
        break
      case 'step/start':
        assert.notEqual(this.turn, null)
        assert.equal(this.step, null, 'nested step')
        this.step = data.step
        break
      case 'step/end':
        assert.equal(data.step, this.step)
        assert.equal(this.tools.size, 0, 'step/end with unresolved tools')
        this.step = null
        break
      case 'assistant/message':
        assert.equal(data.step, this.step, 'assistant message outside its step')
        assert.ok(Array.isArray(data.stream))
        assert.equal(options.surfaceOp, 'append')
        assert.equal(options.sourceEventSeqs, undefined)
        for (const block of data.message.content) {
          if (block.type !== 'tool-call') continue
          assert.equal(typeof block.arguments, 'string')
          this.tools.set(block.id, { name: block.name, arguments: block.arguments, started: false })
        }
        break
      case 'assistant/attempt':
        assert.equal(data.step, this.step)
        break
      case 'tool/call': {
        assert.equal(data.step, this.step)
        const pending = this.tools.get(data.callId)
        assert.ok(pending, `tool/call ${data.callId} was not advertised`)
        assert.equal(pending.started, false)
        assert.equal(pending.name, data.name)
        assert.equal(pending.arguments, data.arguments)
        pending.started = true
        break
      }
      case 'tool/result': {
        assert.equal(data.step, this.step)
        const id = data.message.toolCallId
        const pending = this.tools.get(id)
        assert.ok(pending?.started, `tool/result ${id} has no started call`)
        assert.equal(options.surfaceOp, 'append')
        this.tools.delete(id)
        break
      }
      case 'tool/ptc-dispatch-start':
      case 'tool/ptc-dispatch':
        assert.notEqual(this.turn, null)
        assert.ok(this.tools.has(data.rootCallId), 'dispatch outside its advertised root call')
        break
      default:
        break
    }
  }
}

function rig() {
  const session = new RuleSession()
  const frames = []
  const agent = Object.create(GrokWebAgent.prototype)
  Object.assign(agent, {
    id: 'local-1',
    session,
    remoteSessionId: 'r',
    grokModel: 'grok-4.7',
    streamRevision: 0,
    attemptCounter: 0,
    dispatch: { emit(name, payload) { frames.push({ name, payload }) } },
    hostCtx: { logger: { warn() {} } },
  })
  session.append('turn/start', { turn: 1 })
  const active = createTurnState(1)
  agent.active = active
  const send = update => agent.handleUpdate({ sessionId: 'r', update })
  const text = value => send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
  const thought = value => send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: value } })
  const call = (id, kind, title, rawInput = {}) => send({ sessionUpdate: 'tool_call', toolCallId: id, kind, title, rawInput })
  const done = (id, body = 'ok', status = 'completed', extra = {}) => send({
    sessionUpdate: 'tool_call_update', toolCallId: id, status, content: [{ type: 'content', content: { type: 'text', text: body } }], ...extra,
  })
  const finish = (interrupted = false, message) => {
    agent.finishTurn(active, interrupted, message)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return session.events.map(event => event.type)
  }
  return { agent, session, frames, text, thought, call, done, finish, active, send }
}

describe('Grok turn lifecycle against DSH step rules', () => {
  it('records a text-only answer as one step', async () => {
    const t = rig()
    await t.thought('thinking')
    await t.text('hello')
    const types = t.finish()
    assert.deepEqual(types, ['turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
    const message = t.session.events[2].data.message.content
    assert.deepEqual(message.map(block => block.type), ['reasoning', 'text'])
  })

  it('advertises one activity group per run of routine tools and settles its children', async () => {
    const t = rig()
    await t.text('Looking around. ')
    await t.call('r1', 'read', 'read_file · a.txt')
    await t.call('r2', 'search', 'grep · foo')
    await t.done('r1')
    await t.done('r2')
    await t.text('Found it.')
    const types = t.finish()
    assert.deepEqual(types, [
      'turn/start',
      'step/start', 'assistant/message', 'tool/call',
      'tool/ptc-dispatch-start', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'tool/ptc-dispatch',
      'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end',
      'turn/end',
    ])
    const root = t.session.events[3].data
    assert.equal(root.name, 'grok_build_activity')
    const summary = t.session.events[8].data.meta.grokActivity
    assert.deepEqual(summary, { total: 2, failed: 0, counts: { read: 1, command: 0, search: 1, edit: 0, other: 0 } })
    assert.deepEqual(t.session.events[2].data.message.content.map(block => block.type), ['text', 'tool-call'])
  })

  it('keeps a running tool alive when text arrives before its result', async () => {
    const t = rig()
    await t.call('r1', 'execute', 'run_terminal_command · npm test')
    await t.thought('still thinking while the command runs')
    await t.text('partial answer ')
    await t.done('r1', 'all tests passed')
    await t.text('final answer')
    const types = t.finish()
    assert.deepEqual(types, [
      'turn/start',
      'step/start', 'assistant/message', 'tool/call', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end',
      'turn/end',
    ])
    const settled = t.session.events[5].data
    assert.equal(settled.isError, false)
    assert.deepEqual(settled.content, [{ type: 'text', text: 'all tests passed' }])
    const text = t.session.events[9].data.message.content
    assert.deepEqual(text.map(block => block.type), ['reasoning', 'text'])
    assert.equal(text.find(block => block.type === 'text').text, 'partial answer final answer')
  })

  it('does not fail a tool that is still pending when the turn ends in an error', async () => {
    const t = rig()
    await t.call('r1', 'read', 'read_file · a.txt')
    await t.text('thinking')
    const types = t.finish(true, 'Grok turn cancelled')
    assert.equal(types.at(-1), 'turn/end')
    const settled = t.session.events.find(event => event.type === 'tool/ptc-dispatch').data
    assert.equal(settled.isError, true)
  })

  it('gives every file edit its own advertised step and carries diffs', async () => {
    const t = rig()
    await t.call('e1', 'edit', 'apply_patch · a.txt', { path: 'a.txt' })
    await t.text('Waiting for approval. ')
    await t.done('e1', 'done', 'completed', {
      content: [{ type: 'diff', path: 'a.txt', oldText: 'a', newText: 'b' }],
    })
    const types = t.finish()
    assert.deepEqual(types, [
      'turn/start',
      'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end',
      'turn/end',
    ])
    assert.deepEqual(t.session.events[4].data.meta.diffs, [{ path: 'a.txt', oldText: 'a', newText: 'b' }])
    assert.equal(t.session.events[7].data.message.content[0].text, 'Waiting for approval. ')
  })

  it('queues an edit behind unfinished routine calls', async () => {
    const t = rig()
    await t.call('r1', 'read', 'read_file · a.txt')
    await t.call('e1', 'edit', 'write · a.txt', { path: 'a.txt' })
    await t.done('e1', 'written')
    await t.done('r1')
    const types = t.finish()
    assert.deepEqual(types, [
      'turn/start',
      'step/start', 'assistant/message', 'tool/call', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'turn/end',
    ])
  })

  it('closes dangling tools and the open step when the turn fails midway', async () => {
    const t = rig()
    await t.call('r1', 'execute', 'run_terminal_command · npm test')
    await t.call('e1', 'edit', 'write · a.txt', { path: 'a.txt' })
    const types = t.finish(true, 'Grok turn cancelled')
    assert.equal(types.at(-1), 'turn/end')
    const results = t.session.events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 2)
    assert.equal(results.every(event => event.data.message.isError), true)
  })

  it('starts a tool with rawInput that arrived in a later update', async () => {
    const t = rig()
    await t.send({ sessionUpdate: 'tool_call', toolCallId: 'r1', kind: 'read', title: 'read_file · a.txt' })
    assert.equal(t.session.events.some(event => event.type === 'tool/ptc-dispatch-start'), false)
    await t.send({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'r1',
      rawInput: { path: 'a.txt' },
    })
    const start = t.session.events.find(event => event.type === 'tool/ptc-dispatch-start')
    assert.deepEqual(start.data.arguments, { path: 'a.txt' })
    await t.done('r1')
    t.finish()
  })

  it('starts a tool when the result arrives before any rawInput', async () => {
    const t = rig()
    await t.send({ sessionUpdate: 'tool_call', toolCallId: 'r1', kind: 'read', title: 'read_file · a.txt' })
    assert.equal(t.session.events.some(event => event.type === 'tool/ptc-dispatch-start'), false)
    await t.done('r1', 'file contents')
    const start = t.session.events.find(event => event.type === 'tool/ptc-dispatch-start')
    assert.ok(start)
    const settled = t.session.events.find(event => event.type === 'tool/ptc-dispatch')
    assert.equal(settled.data.isError, false)
    t.finish()
  })

  it('starts a tool after the settle timer when rawInput never arrives', async () => {
    const t = rig()
    const timers = []
    t.agent.scheduleToolSettle = (fn, ms) => {
      timers.push({ fn, ms })
      return () => { timers.at(-1).cancelled = true }
    }
    await t.send({ sessionUpdate: 'tool_call', toolCallId: 'r1', kind: 'read', title: 'read_file · a.txt' })
    assert.equal(t.session.events.some(event => event.type === 'tool/ptc-dispatch-start'), false)
    assert.equal(timers.length, 1)
    assert.equal(timers[0].ms, TOOL_SETTLE_MS)
    timers[0].fn()
    const start = t.session.events.find(event => event.type === 'tool/ptc-dispatch-start')
    assert.ok(start)
    await t.done('r1')
    t.finish()
  })

  it('publishes live stream frames with a closing commit', async () => {
    const t = rig()
    await t.text('a')
    await t.call('r1', 'read', 'read_file · a.txt')
    await t.done('r1')
    t.finish()
    const kinds = t.frames.map(frame => frame.payload.frame.type)
    assert.equal(kinds.filter(kind => kind === 'start').length, 1)
    assert.equal(kinds.filter(kind => kind === 'end').length, 1)
    const revisions = t.frames.map(frame => frame.payload.frame.revision)
    assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b))
  })
})
