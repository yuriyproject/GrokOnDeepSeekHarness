import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpHost, MAX_FILE_BYTES } from '../lib/acp-connection.js'
import { abortable } from '../lib/grok-agent.js'
import { SessionMapping } from '../lib/mapping.js'
import { describeToolInput, redactSecrets } from '../lib/redact.js'
import { transcriptForReplay } from '../lib/render.js'
import { assertInside, assertUnambiguousPath } from '../lib/workspace-path.js'
import { isTrustedRequest } from '../lib/http-route.js'
import { WEB_COMMANDS, WITHHELD_COMMANDS } from '../lib/preset-marker.js'

async function tempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-grok-hardening-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('Windows path ambiguity', () => {
  it('rejects trailing dots and spaces that Win32 reads as a parent segment', () => {
    for (const bad of ['sub\\.. \\..\\x', 'a\\...\\b', 'a\\.. \\b', 'a/. /b']) {
      assert.throws(() => assertUnambiguousPath(bad, 'win32'), /ambiguous/, bad)
    }
  })

  it('rejects device names and alternate data streams', () => {
    for (const bad of ['NUL', 'dir\\con.txt', 'COM1', 'lpt3.log', 'file.txt:stream']) {
      assert.throws(() => assertUnambiguousPath(bad, 'win32'), /device|stream/, bad)
    }
  })

  it('accepts ordinary names, drive prefixes and plain dot segments', () => {
    for (const ok of ['src/a.txt', 'C:\\work\\a.txt', '.\\a\\..\\b', 'console.log', 'my file.txt', '.hidden']) {
      assert.doesNotThrow(() => assertUnambiguousPath(ok, 'win32'), ok)
    }
  })

  it('does not apply Windows-only rules on POSIX', () => {
    assert.doesNotThrow(() => assertUnambiguousPath('nul', 'linux'))
    assert.throws(() => assertUnambiguousPath('a\0b', 'linux'), /NUL byte/)
  })

  it('judges containment by relative path, so a sibling with the same prefix is outside', () => {
    const base = process.platform === 'win32' ? 'C:\\work\\ws' : '/work/ws'
    const sibling = process.platform === 'win32' ? 'C:\\work\\ws-evil\\a' : '/work/ws-evil/a'
    assert.throws(() => assertInside(base, sibling), /escapes/)
    assert.doesNotThrow(() => assertInside(base, `${base}${process.platform === 'win32' ? '\\' : '/'}a`))
    assert.doesNotThrow(() => assertInside(base, base))
  })
})

describe('SessionMapping robustness', () => {
  it('moves a corrupt file aside and starts empty instead of failing', async () => {
    await tempDir(async (dir) => {
      const file = join(dir, 'map.json')
      await writeFile(file, '{"version":2,"sessions":{}}\n')
      const warnings = []
      const mapping = new SessionMapping(file, { warn: message => warnings.push(message) })
      assert.equal(mapping.get('x'), undefined)
      assert.equal(warnings.length, 1)
      const names = await readdir(dir)
      assert.ok(names.some(name => name.startsWith('map.json.corrupt-')))
      mapping.set('a', 'remote-a')
      assert.equal(JSON.parse(await readFile(file, 'utf8')).sessions.a, 'remote-a')
    })
  })

  it('keeps entries written by another process on the same file', async () => {
    await tempDir(async (dir) => {
      const file = join(dir, 'map.json')
      const first = new SessionMapping(file)
      const second = new SessionMapping(file)
      first.set('a', 'remote-a')
      second.set('b', 'remote-b')
      const stored = JSON.parse(await readFile(file, 'utf8')).sessions
      assert.deepEqual(stored, { a: 'remote-a', b: 'remote-b' })
      assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.lock')), [])
    })
  })
})

describe('abortable prompt', () => {
  it('resolves with the answer when Grok responds', async () => {
    const result = await abortable(Promise.resolve('ok'), new AbortController().signal, 20)
    assert.equal(result, 'ok')
  })

  it('rejects after the grace period when Grok ignores the cancel', async () => {
    const controller = new AbortController()
    const never = new Promise(() => {})
    const waiting = abortable(never, controller.signal, 30)
    controller.abort({ kind: 'user' })
    await assert.rejects(waiting, error => error.kind === 'user')
  })

  it('lets a late answer win inside the grace period', async () => {
    const controller = new AbortController()
    const late = new Promise(resolve => setTimeout(() => resolve('cancelled'), 10))
    const waiting = abortable(late, controller.signal, 200)
    controller.abort({ kind: 'user' })
    assert.equal(await waiting, 'cancelled')
  })
})

describe('idle shutdown', () => {
  function host() {
    const instance = new AcpHost({ logger: { warn() {} } }, { stateFile: join(tmpdir(), `dsh-grok-idle-${process.pid}.json`), idleDisposeMs: 15 })
    let disposed = 0
    instance.disposeProcess = async () => { disposed += 1 }
    return { instance, disposed: () => disposed }
  }

  it('does not stop the process while a session is being opened', async () => {
    const { instance, disposed } = host()
    instance.opening = 1
    instance.scheduleIdleDispose()
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(disposed(), 0)
  })

  it('cancels a pending stop as soon as the process is requested again', async () => {
    const { instance, disposed } = host()
    instance.process = { conn: {} }
    instance.scheduleIdleDispose()
    await instance.ensureProcess()
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(disposed(), 0)
  })

  it('still stops an idle process', async () => {
    const { instance, disposed } = host()
    instance.scheduleIdleDispose()
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(disposed(), 1)
  })
})

describe('resume that loses the Grok context', () => {
  it('reports contextLost when the mapped session cannot be resumed or loaded', async () => {
    await tempDir(async (dir) => {
      const instance = new AcpHost({ logger: { warn() {} } }, { stateFile: join(dir, 'map.json') })
      instance.mapping.set('local-1', 'remote-old')
      instance.capabilities = { sessionCapabilities: { resume: {} }, loadSession: true }
      instance.process = {
        conn: {
          resumeSession: async () => { throw new Error('gone') },
          loadSession: async () => { throw new Error('gone') },
          newSession: async () => ({ sessionId: 'remote-new' }),
        },
      }
      const opened = await instance.openSession('local-1', dir)
      assert.equal(opened.remoteSessionId, 'remote-new')
      assert.equal(opened.contextLost, true)
      assert.equal(instance.mapping.get('local-1'), 'remote-new')
    })
  })

  it('does not report a loss for a session that never had a Grok id', async () => {
    await tempDir(async (dir) => {
      const instance = new AcpHost({ logger: { warn() {} } }, { stateFile: join(dir, 'map.json') })
      instance.process = { conn: { newSession: async () => ({ sessionId: 'remote-new' }) } }
      const opened = await instance.openSession('local-2', dir)
      assert.equal(opened.contextLost, false)
    })
  })

  it('replays the stored conversation, bounded and without the current turn', () => {
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'first question' }] } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'first answer' }] } } },
      { seq: 3, type: 'turn/start', data: { turn: 2 } },
      { seq: 4, type: 'user/message', data: { content: [{ type: 'text', text: 'current question' }] } },
    ]
    const text = transcriptForReplay(events, 3)
    assert.equal(text, 'User: first question\n\nAssistant: first answer')
    assert.equal(transcriptForReplay(events, 3, 25).startsWith('Assistant: first answer'), true)
    assert.equal(transcriptForReplay([], 0), '')
  })
})

describe('approvals', () => {
  function agentFor(dir, extra = {}) {
    return { id: 'a', session: { header: { cwd: dir }, snapshotEvents: () => [] }, ...extra }
  }

  it('shows the command being approved and masks secrets in it', async () => {
    const seen = []
    const instance = new AcpHost({
      logger: { warn() {} },
      approval: { request: async (request) => { seen.push(request); return 'allowed-once' } },
    }, { stateFile: join(tmpdir(), `dsh-grok-approval-${process.pid}.json`) })
    const agent = agentFor(tmpdir())
    instance.agents.set('r', agent)
    const answer = await instance.requestPermission({
      sessionId: 'r',
      toolCall: { toolCallId: 't1', title: 'Bash', kind: 'execute', rawInput: { command: 'curl -H "Authorization: Bearer abcdef1234567890" https://x.test --data TOKEN=hunter2' } },
      options: [{ kind: 'allow_once', optionId: 'yes' }],
    })
    assert.deepEqual(answer, { outcome: { outcome: 'selected', optionId: 'yes' } })
    assert.match(seen[0].reason, /curl/)
    assert.doesNotMatch(seen[0].reason, /abcdef1234567890|hunter2/)
    assert.equal(agent.turnApprovals, 1)
  })

  it('asks before a file write that no permission covered, and refuses when declined', async () => {
    await tempDir(async (dir) => {
      const asked = []
      const instance = new AcpHost({
        logger: { warn() {} },
        approval: { request: async (request) => { asked.push(request); return 'rejected' } },
      }, { stateFile: join(dir, 'map.json'), allowOutsideWorkspace: false })
      instance.agents.set('r', agentFor(dir, { turnApprovals: 0 }))
      await assert.rejects(instance.writeTextFile({ sessionId: 'r', path: 'a.txt', content: 'x' }), /not approved/)
      assert.equal(asked.length, 1)
      await assert.rejects(stat(join(dir, 'a.txt')), { code: 'ENOENT' })
    })
  })

  it('writes without a second prompt after a permission was granted in the turn', async () => {
    await tempDir(async (dir) => {
      const instance = new AcpHost({
        logger: { warn() {} },
        approval: { request: async () => { throw new Error('must not ask again') } },
      }, { stateFile: join(dir, 'map.json'), allowOutsideWorkspace: false })
      instance.agents.set('r', agentFor(dir, { turnApprovals: 1 }))
      await instance.writeTextFile({ sessionId: 'r', path: 'sub/a.txt', content: 'x' })
      assert.equal(await readFile(join(dir, 'sub', 'a.txt'), 'utf8'), 'x')
    })
  })

  it('refuses files above the size limit in both directions', async () => {
    await tempDir(async (dir) => {
      const instance = new AcpHost({ logger: { warn() {} } }, { stateFile: join(dir, 'map.json'), allowOutsideWorkspace: false })
      instance.agents.set('r', agentFor(dir, { turnApprovals: 1 }))
      await assert.rejects(
        instance.writeTextFile({ sessionId: 'r', path: 'big.txt', content: 'x'.repeat(MAX_FILE_BYTES + 1) }),
        /too large/,
      )
      await writeFile(join(dir, 'big.bin'), Buffer.alloc(MAX_FILE_BYTES + 1))
      await assert.rejects(instance.readTextFile({ sessionId: 'r', path: 'big.bin' }), /too large/)
    })
  })
})

describe('redaction', () => {
  it('masks assignments, bearer tokens, known key shapes and URL credentials', () => {
    const text = redactSecrets('API_KEY=abc123 Authorization: Bearer abcdefghijkl sk-ABCDEFGHIJKLMNOP1234 https://user:pw@host/x')
    assert.doesNotMatch(text, /abc123|abcdefghijkl|ABCDEFGHIJKLMNOP|user:pw/)
    assert.match(text, /API_KEY=\*\*\*/)
  })

  it('summarizes a tool input without dumping huge payloads', () => {
    const detail = describeToolInput({ title: 'Edit', rawInput: { path: 'a.txt', content: 'x'.repeat(5000) } })
    assert.ok(detail.length < 700)
    assert.match(detail, /a\.txt/)
  })
})

describe('approval text', () => {
  it('does not repeat a path that the title already contains', () => {
    assert.equal(describeToolInput({ title: 'Write `C:\w\a.txt`', rawInput: { path: 'C:\w\a.txt' } }).split('a.txt').length - 1, 1)
  })
})

describe('/always-approve', () => {
  it('is not offered, because DSH approval policy cannot back it honestly', () => {
    assert.equal(WITHHELD_COMMANDS.has('always-approve'), true)
    assert.equal(WEB_COMMANDS.some(command => command.name === 'always-approve'), false)
  })
})

describe('loopback trust', () => {
  const request = (headers, remote, local) => ({ headers, socket: { remoteAddress: remote, localAddress: local } })

  it('accepts a loopback client on a loopback listener', () => {
    assert.equal(isTrustedRequest(request({ host: '127.0.0.1:3080' }, '127.0.0.1', '127.0.0.1'), false), true)
    assert.equal(isTrustedRequest(request({ host: 'localhost:3080' }, '::ffff:127.0.0.1', '::1'), false), true)
  })

  it('rejects a LAN peer that spoofs a loopback Host header', () => {
    assert.equal(isTrustedRequest(request({ host: '127.0.0.1:3080' }, '192.168.1.20', '192.168.1.5'), false), false)
    assert.equal(isTrustedRequest(request({ host: '127.0.0.1:3080' }, '192.168.1.20', '127.0.0.1'), false), false)
  })
})
