import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpHost } from '../lib/acp-connection.js'
import { CONFIG_EFFORT, CONFIG_MODEL, DEFAULT_GROK_MODEL } from '../lib/constants.js'
import { snapshotFor } from '../lib/web-route.js'

async function withHost(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-grok-session-model-'))
  const host = new AcpHost({}, {
    stateFile: join(root, 'sessions.json'),
    command: 'grok',
    args: [],
    allowOutsideWorkspace: false,
    idleDisposeMs: 0,
  })
  try {
    await run(host)
  } finally {
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

function fakeAgent(id) {
  return {
    id,
    grokModel: DEFAULT_GROK_MODEL,
    grokEffort: undefined,
    grokConfigOptions: undefined,
    attachHost(host, remoteSessionId, generation) {
      this.host = host
      this.remoteSessionId = remoteSessionId
      this.hostGeneration = generation
    },
    handleUpdate() {
      return Promise.resolve()
    },
  }
}

function grokRecord(agent) {
  return { underlying: { agent } }
}

function snapshot(host, sessionId, agent, models = host.models) {
  host.models = models
  const session = { id: sessionId, snapshotEvents: () => [] }
  const router = {
    recordFor(id) {
      return String(id) === String(sessionId) ? grokRecord(agent) : undefined
    },
    lastDsh() {
      return 'standard'
    },
  }
  return snapshotFor({}, session, router, host, () => 'grok-build')
}

const catalog = [
  { modelId: 'grok-a', name: 'Grok A', _meta: { reasoningEffort: 'low', reasoningEfforts: [{ id: 'low' }, { id: 'high' }] } },
  { modelId: 'grok-b', name: 'Grok B', _meta: { reasoningEffort: 'high', reasoningEfforts: [{ id: 'low' }, { id: 'high' }] } },
]

describe('per-session Grok model and effort', () => {
  it('keeps model, effort and config options on the session that received them', async () => {
    await withHost(async (host) => {
      host.models = catalog
      const agentA = fakeAgent('local-a')
      const agentB = fakeAgent('local-b')

      host.ingestSession({
        sessionId: 'remote-a',
        models: { currentModelId: 'grok-a', availableModels: catalog },
        configOptions: [
          { id: CONFIG_MODEL, category: 'model', currentValue: 'grok-a' },
          { id: CONFIG_EFFORT, category: 'thought_level', currentValue: 'low' },
        ],
      })
      host.bindAgent('remote-a', agentA)

      host.ingestSession({
        sessionId: 'remote-b',
        models: { currentModelId: 'grok-b', availableModels: catalog },
        configOptions: [
          { id: CONFIG_MODEL, category: 'model', currentValue: 'grok-b' },
          { id: CONFIG_EFFORT, category: 'thought_level', currentValue: 'high' },
        ],
      })
      host.bindAgent('remote-b', agentB)

      assert.equal(agentA.grokModel, 'grok-a')
      assert.equal(agentA.grokEffort, 'low')
      assert.equal(agentB.grokModel, 'grok-b')
      assert.equal(agentB.grokEffort, 'high')

      const snapA = snapshot(host, 'sess-a', agentA)
      const snapB = snapshot(host, 'sess-b', agentB)
      assert.equal(snapA.grok.model, 'grok-a')
      assert.equal(snapA.grok.effort, 'low')
      assert.equal(snapB.grok.model, 'grok-b')
      assert.equal(snapB.grok.effort, 'high')
      assert.deepEqual(snapA.grok.models.map(model => model.id), ['grok-a', 'grok-b'])
      assert.deepEqual(snapB.grok.models.map(model => model.id), ['grok-a', 'grok-b'])
    })
  })

  it('does not let session B updates change what session A displays', async () => {
    await withHost(async (host) => {
      host.models = catalog
      const agentA = fakeAgent('local-a')
      const agentB = fakeAgent('local-b')
      host.bindAgent('remote-a', agentA)
      host.bindAgent('remote-b', agentB)
      agentA.grokModel = 'grok-a'
      agentA.grokEffort = 'low'
      agentB.grokModel = 'grok-a'
      agentB.grokEffort = 'low'

      await host.handleUpdate({
        sessionId: 'remote-b',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: [
            { id: CONFIG_MODEL, category: 'model', currentValue: 'grok-b' },
            { id: CONFIG_EFFORT, category: 'thought_level', currentValue: 'high' },
          ],
        },
      })
      await host.handleUpdate({
        sessionId: 'remote-b',
        update: { sessionUpdate: 'model_changed', currentModelId: 'grok-b' },
      })

      assert.equal(agentA.grokModel, 'grok-a')
      assert.equal(agentA.grokEffort, 'low')
      assert.equal(agentB.grokModel, 'grok-b')
      assert.equal(agentB.grokEffort, 'high')
      assert.equal(snapshot(host, 'sess-a', agentA).grok.model, 'grok-a')
      assert.equal(snapshot(host, 'sess-a', agentA).grok.effort, 'low')
      assert.equal(snapshot(host, 'sess-b', agentB).grok.model, 'grok-b')
      assert.equal(snapshot(host, 'sess-b', agentB).grok.effort, 'high')
    })
  })

  it('applies setConfigOption only to the remote session it was called with', async () => {
    await withHost(async (host) => {
      host.models = catalog
      const remote = {
        'remote-a': { model: 'grok-a', effort: 'low' },
        'remote-b': { model: 'grok-a', effort: 'low' },
      }
      host.process = {
        conn: {
          async setSessionConfigOption({ sessionId, configId, value }) {
            const state = remote[sessionId]
            if (configId === CONFIG_MODEL) state.model = value
            if (configId === CONFIG_EFFORT) state.effort = value
            return {
              configOptions: [
                { id: CONFIG_MODEL, category: 'model', currentValue: state.model },
                { id: CONFIG_EFFORT, category: 'thought_level', currentValue: state.effort },
              ],
            }
          },
        },
        dispose: async () => {},
      }
      const agentA = fakeAgent('local-a')
      const agentB = fakeAgent('local-b')
      host.bindAgent('remote-a', agentA)
      host.bindAgent('remote-b', agentB)
      agentA.grokModel = 'grok-a'
      agentA.grokEffort = 'low'
      agentB.grokModel = 'grok-a'
      agentB.grokEffort = 'low'

      await host.setConfigOption('remote-b', CONFIG_MODEL, 'grok-b')
      await host.setConfigOption('remote-b', CONFIG_EFFORT, 'high')

      assert.equal(agentA.grokModel, 'grok-a')
      assert.equal(agentA.grokEffort, 'low')
      assert.equal(agentB.grokModel, 'grok-b')
      assert.equal(agentB.grokEffort, 'high')
      assert.equal(snapshot(host, 'sess-a', agentA).grok.effort, 'low')
      assert.equal(snapshot(host, 'sess-b', agentB).grok.effort, 'high')
    })
  })
})
