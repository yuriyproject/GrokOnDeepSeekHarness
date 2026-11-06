import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpHost } from '../lib/acp-connection.js'
import { grokIdFromEvents, linkRecord, preferMappedGrokId } from '../lib/session-link.js'

async function tempDir(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-grok-link-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function linkEvent(id, seq = 0) {
  return { ...linkRecord(id), seq, time: 1, ignorable: true }
}

describe('grokIdFromEvents', () => {
  it('returns the newest ignorable link and ignores everything else', () => {
    assert.equal(grokIdFromEvents(undefined), undefined)
    assert.equal(grokIdFromEvents([]), undefined)
    assert.equal(grokIdFromEvents([
      { type: 'user/message', data: { grokSessionId: 'nope' } },
      { ...linkRecord('missing-marker'), seq: 1, time: 1 },
      { type: linkRecord('older').type, seq: 2, time: 1, ignorable: true, data: { grokSessionId: '' } },
      linkEvent('older', 3),
      { type: 'turn/end', data: {} },
      linkEvent('newer', 5),
    ]), 'newer')
  })
})

describe('fallback order', () => {
  it('keeps the JSON map ahead of the session log', () => {
    const events = [linkEvent('from-log')]
    assert.equal(preferMappedGrokId('from-json', events), 'from-json')
    assert.equal(preferMappedGrokId(undefined, events), 'from-log')
    assert.equal(preferMappedGrokId('', events), 'from-log')
    assert.equal(preferMappedGrokId(undefined, []), undefined)
  })
})

describe('session log record', () => {
  it('appends the Grok id when a bound session can take a plugin record', async () => {
    await tempDir(async (dir) => {
      const warnings = []
      const resumed = []
      const session = Session.create('local-1', undefined, {
        version: 4,
        id: 'local-1',
        createdAt: 1,
        isSeeded: false,
        cwd: dir,
      })
      const instance = new AcpHost(
        { logger: { warn(message) { warnings.push(message) } } },
        { stateFile: join(dir, 'map.json') },
      )
      instance.agents.set('bound', { id: 'local-1', session })
      instance.capabilities = { sessionCapabilities: { resume: {} } }
      instance.process = {
        conn: {
          resumeSession: async ({ sessionId }) => {
            resumed.push(sessionId)
            return { sessionId }
          },
          newSession: async () => ({ sessionId: 'remote-new' }),
        },
      }

      const opened = await instance.openSession('local-1', dir)
      assert.equal(opened.remoteSessionId, 'remote-new')
      assert.deepEqual(resumed, [])
      assert.equal(grokIdFromEvents(session.snapshotEvents()), 'remote-new')
      assert.equal(warnings.length, 0)

      const again = await instance.openSession('local-1', dir)
      assert.equal(again.remoteSessionId, 'remote-new')
      assert.deepEqual(resumed, ['remote-new'])
      assert.equal(session.snapshotEvents().filter(event => event.type === linkRecord('remote-new').type).length, 1)
    })
  })

  it('uses the log when the JSON map has no entry, and the map when it does', async () => {
    await tempDir(async (dir) => {
      const session = Session.create('local-1', [linkEvent('from-log')], {
        version: 4,
        id: 'local-1',
        createdAt: 1,
        isSeeded: false,
        cwd: dir,
      })
      const resumed = []
      const instance = new AcpHost(
        { logger: { warn() {} } },
        { stateFile: join(dir, 'map.json') },
      )
      instance.agents.set('bound', { id: 'local-1', session })
      instance.capabilities = { sessionCapabilities: { resume: {} }, loadSession: true }
      instance.process = {
        conn: {
          resumeSession: async ({ sessionId }) => {
            resumed.push(sessionId)
            return { sessionId }
          },
          loadSession: async () => { throw new Error('unused') },
          newSession: async () => ({ sessionId: 'should-not-run' }),
        },
      }

      const fromLog = await instance.openSession('local-1', dir)
      assert.equal(fromLog.remoteSessionId, 'from-log')
      assert.deepEqual(resumed, ['from-log'])

      instance.mapping.set('local-1', 'from-json')
      const fromJson = await instance.openSession('local-1', dir)
      assert.equal(fromJson.remoteSessionId, 'from-json')
      assert.deepEqual(resumed, ['from-log', 'from-json'])
    })
  })

  it('does not fail the open when the bound session rejects the record', async () => {
    await tempDir(async (dir) => {
      const warnings = []
      const instance = new AcpHost(
        { logger: { warn(message) { warnings.push(message) } } },
        { stateFile: join(dir, 'map.json') },
      )
      instance.agents.set('bound', {
        id: 'local-1',
        session: { snapshotEvents: () => [] },
      })
      instance.process = { conn: { newSession: async () => ({ sessionId: 'remote-new' }) } }
      const opened = await instance.openSession('local-1', dir)
      assert.equal(opened.remoteSessionId, 'remote-new')
      assert.equal(opened.contextLost, false)
      assert.equal(warnings.length, 1)
    })
  })
})
