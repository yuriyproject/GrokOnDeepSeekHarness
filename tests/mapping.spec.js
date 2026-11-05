import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionMapping } from '../lib/mapping.js'

async function withState(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-grok-mapping-'))
  const stateFile = join(root, 'sessions.json')
  try {
    await run(stateFile)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('SessionMapping', () => {
  it('persists mappings for a later process', async () => {
    await withState(async (stateFile) => {
      const first = new SessionMapping(stateFile)
      first.set('local-b', 'remote-b')
      first.set('local-a', 'remote-a')

      const second = new SessionMapping(stateFile)
      assert.equal(second.get('local-a'), 'remote-a')
      assert.equal(second.get('local-b'), 'remote-b')
      assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), {
        version: 1,
        sessions: { 'local-a': 'remote-a', 'local-b': 'remote-b' },
      })
    })
  })

  it('writes owner-only state files', { skip: process.platform === 'win32' && 'POSIX modes are not enforced on Windows' }, async () => {
    await withState(async (stateFile) => {
      new SessionMapping(stateFile).set('local', 'remote')
      assert.equal((await stat(stateFile)).mode & 0o777, 0o600)
    })
  })

  it('sets a corrupt state file aside instead of failing to load', async () => {
    await withState(async (stateFile) => {
      await writeFile(stateFile, '{"version":2,"sessions":{}}')
      const mapping = new SessionMapping(stateFile, { warn() {} })
      assert.equal(mapping.get('x'), undefined)
    })
  })
})
