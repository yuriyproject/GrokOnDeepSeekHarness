import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  permissionOutcome,
  planTodos,
  renderToolOutput,
  toAcpPrompt,
} from '../lib/render.js'
import { sessionBlank } from '../lib/dsh.js'
import { isGrokPreset } from '../lib/constants.js'
import {
  activityMeta,
  classifyActivityTool,
  createActivityState,
} from '../lib/activity.js'
import { GrokWebAgent } from '../lib/grok-agent.js'

describe('toAcpPrompt', () => {
  it('keeps text and flattens images', () => {
    assert.deepEqual(
      toAcpPrompt([
        { type: 'text', text: 'hello' },
        { type: 'image', attachment: { id: '1' } },
        { type: 'reasoning', text: 'secret' },
      ]),
      [
        { type: 'text', text: 'hello' },
        { type: 'text', text: '[image attached]' },
      ],
    )
  })

  it('maps inline image bytes to ACP image content when the agent accepts images', () => {
    const png = 'iVBORw0KGgo='
    assert.deepEqual(
      toAcpPrompt([
        { type: 'image', mimeType: 'image/png', data: png },
        { type: 'image', mediaType: 'image/jpeg', data: png, name: 'shot.jpg' },
      ], { image: true }),
      [
        { type: 'image', data: png, mimeType: 'image/png' },
        { type: 'image', data: png, mimeType: 'image/jpeg' },
      ],
    )
  })

  it('keeps a placeholder when image prompts are not advertised or bytes are missing', () => {
    const png = 'iVBORw0KGgo='
    assert.deepEqual(
      toAcpPrompt([{ type: 'image', mimeType: 'image/png', data: png }], { image: false }),
      [{ type: 'text', text: '[image attached]' }],
    )
    assert.deepEqual(
      toAcpPrompt([{ type: 'image', attachment: { mediaType: 'image/png', name: 'photo.png' } }], { image: true }),
      [{ type: 'text', text: '[image attached: photo.png]' }],
    )
  })
})

describe('permissionOutcome', () => {
  const options = [
    { optionId: 'allow-1', kind: 'allow_once' },
    { optionId: 'deny-1', kind: 'reject_once' },
  ]

  it('maps DSH allow to allow_once', () => {
    assert.deepEqual(permissionOutcome('allowed-once', options), {
      outcome: { outcome: 'selected', optionId: 'allow-1' },
    })
  })

  it('maps DSH reject to reject_once instead of cancelling', () => {
    assert.deepEqual(permissionOutcome('rejected', options), {
      outcome: { outcome: 'selected', optionId: 'deny-1' },
    })
  })

  it('cancels when the user dismisses the prompt', () => {
    assert.deepEqual(permissionOutcome('cancelled', options), {
      outcome: { outcome: 'cancelled' },
    })
  })
})

describe('renderToolOutput', () => {
  it('collects diffs and text', () => {
    const rendered = renderToolOutput({
      content: [
        { type: 'content', content: { type: 'text', text: 'ok' } },
        { type: 'diff', path: 'a.txt', oldText: 'a', newText: 'b' },
      ],
    })
    assert.equal(rendered.text.includes('ok'), true)
    assert.equal(rendered.diffs[0].path, 'a.txt')
  })
})

describe('planTodos', () => {
  it('projects a whole ACP plan into the native DSH todo list', () => {
    assert.deepEqual(
      planTodos({ entries: [
        { status: 'completed', content: ' Read the docs ' },
        { status: 'in_progress', title: 'Run checks' },
        { status: 'unknown', content: 'Package app' },
        { status: 'pending', content: 'Package app' },
        { status: 'pending', content: '   ' },
      ] }),
      [
        { status: 'completed', content: 'Read the docs' },
        { status: 'in_progress', content: 'Run checks' },
        { status: 'pending', content: 'Package app' },
      ],
    )
  })

  it('keeps an empty plan as an explicit empty todo snapshot', () => {
    assert.deepEqual(planTodos({ entries: [] }), [])
  })
})

describe('GrokWebAgent plan projection', () => {
  it('logs the plan for the native todo panel without adding answer text', async () => {
    const events = []
    const agent = Object.create(GrokWebAgent.prototype)
    Object.assign(agent, {
      remoteSessionId: 'remote-1',
      active: {},
      session: {
        append(type, data) {
          events.push({ type, data })
          return { seq: events.length }
        },
      },
    })

    await agent.handleUpdate({
      sessionId: 'remote-1',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { status: 'in_progress', content: 'Run checks' },
          { status: 'pending', content: 'Package app' },
        ],
      },
    })

    assert.deepEqual(events, [{
      type: 'todo/write',
      data: {
        todos: [
          { status: 'in_progress', content: 'Run checks' },
          { status: 'pending', content: 'Package app' },
        ],
      },
    }])
  })
})

describe('Grok activity groups', () => {
  it('classifies routine calls while keeping file mutations standalone', () => {
    assert.equal(classifyActivityTool({ kind: 'read', title: 'read_file · README.md' }), 'read')
    assert.equal(classifyActivityTool({ kind: 'execute', title: 'run_terminal_command · npm test' }), 'command')
    assert.equal(classifyActivityTool({ kind: 'search', title: 'grep · tool_call' }), 'search')
    assert.equal(classifyActivityTool({ kind: 'edit', title: 'apply_patch · README.md' }), 'edit')
  })

  it('marks the group failed so the collapsed row cannot hide errors', () => {
    const activity = createActivityState(1, 1)
    activity.counts.command = 1
    activity.failed = 1
    assert.deepEqual(activityMeta(activity), {
      total: 1,
      failed: 1,
      counts: { read: 0, command: 1, search: 0, edit: 0, other: 0 },
    })
  })
})

describe('session helpers', () => {
  it('treats only grok-build as the Grok harness', () => {
    assert.equal(isGrokPreset('grok-build'), true)
    assert.equal(isGrokPreset('standard'), false)
  })

  it('treats a session without turns as blank', () => {
    assert.equal(sessionBlank(undefined, { snapshotEvents: () => [] }), true)
    assert.equal(sessionBlank(undefined, { snapshotEvents: () => [{ type: 'turn/start' }] }), false)
    const ctx = { agents: { turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: 0 }) } }
    assert.equal(sessionBlank(ctx, {}), true)
    const started = { agents: { turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: 2 }) } }
    assert.equal(sessionBlank(started, {}), false)
  })
})

describe('inlineImages', () => {
  const ref = { attachmentId: 'a1', mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'shot.png' }

  it('reads attachment bytes through the store and sends them as ACP images', async () => {
    const { inlineImages, toAcpPrompt } = await import('../lib/render.js')
    const store = { readImage: async () => ({ ref, data: new Uint8Array([1, 2, 3]) }) }
    const content = await inlineImages([{ type: 'text', text: 'look' }, { type: 'image', attachment: ref }], store)
    assert.deepEqual(toAcpPrompt(content, { image: true }), [
      { type: 'text', text: 'look' },
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
    ])
  })

  it('keeps a named placeholder when the read fails or no store exists', async () => {
    const { inlineImages, toAcpPrompt } = await import('../lib/render.js')
    const failing = { readImage: async () => { throw new Error('gone') } }
    for (const store of [failing, undefined]) {
      const content = await inlineImages([{ type: 'image', attachment: ref, name: 'shot.png' }], store)
      assert.deepEqual(toAcpPrompt(content, { image: true }), [{ type: 'text', text: '[image attached: shot.png]' }])
    }
  })
})
