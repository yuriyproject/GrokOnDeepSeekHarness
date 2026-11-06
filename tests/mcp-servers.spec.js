import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpHost } from '../lib/acp-connection.js'
import { DSH_MCP_CLIENT } from '../lib/mcp-servers.js'
import { redactMcpServers, scrubSecretValues, toAcpMcpServers } from '../lib/mcp-servers.js'

const SECRET = 'plane_live_token_9f3a'
const HEADER_SECRET = 'Bearer header-secret-value'

const definitions = [
  {
    transport: 'stdio',
    serverName: 'local',
    command: 'npx',
    args: ['-y', 'some-mcp', `--token=${SECRET}`],
    env: { MCP_TOKEN: SECRET, EMPTY: '' },
  },
  {
    transport: 'streamable-http',
    serverName: 'web',
    url: `https://user:${SECRET}@example.test/mcp?access_token=${SECRET}`,
    headers: { Authorization: HEADER_SECRET },
  },
  {
    transport: 'sse',
    serverName: 'events',
    url: 'https://example.test/sse',
    headers: {},
  },
  {
    transport: 'acp',
    serverName: 'unstable',
  },
  {
    transport: 'stdio',
    serverName: '   ',
    command: 'C:\\tools\\mcp.exe',
  },
  {
    transport: 'stdio',
    serverName: 'local',
    command: 'C:\\other\\mcp.exe',
  },
]

describe('toAcpMcpServers', () => {
  const caps = { http: true, sse: true }

  it('converts stdio and streamable-http and keeps secrets only in the payload', () => {
    const servers = toAcpMcpServers(definitions, caps)
    assert.deepEqual(servers.map((server) => server.name), ['local', 'web', 'events'])
    assert.deepEqual(servers[0], {
      name: 'local',
      command: 'npx',
      args: ['-y', 'some-mcp', `--token=${SECRET}`],
      env: [{ name: 'MCP_TOKEN', value: SECRET }, { name: 'EMPTY', value: '' }],
    })
    assert.equal('type' in servers[0], false)
    assert.deepEqual(servers[1], {
      type: 'http',
      name: 'web',
      url: `https://user:${SECRET}@example.test/mcp?access_token=${SECRET}`,
      headers: [{ name: 'Authorization', value: HEADER_SECRET }],
    })
    assert.equal(servers[2].type, 'sse')
  })

  it('drops transports Grok does not advertise and empty names', () => {
    const servers = toAcpMcpServers(definitions, {})
    assert.deepEqual(servers.map((server) => server.name), ['local'])
    assert.equal(toAcpMcpServers(definitions, { http: true }).some((server) => server.type === 'sse'), false)
    assert.equal(toAcpMcpServers([{ transport: 'stdio', serverName: '', command: 'x' }], caps).length, 0)
    assert.equal(toAcpMcpServers([{ transport: 'streamable-http', serverName: 'no-url' }], { http: true }).length, 0)
  })
})

describe('redactMcpServers', () => {
  it('removes secret values from the logged copy', () => {
    const servers = toAcpMcpServers(definitions, { http: true, sse: true })
    const redacted = redactMcpServers(servers)
    const printed = JSON.stringify(redacted)
    assert.equal(printed.includes(SECRET), false)
    assert.equal(printed.includes(HEADER_SECRET), false)
    assert.equal(printed.includes('header-secret-value'), false)
    assert.match(printed, /"value":"\*\*\*"/)
    assert.equal(redacted[1].url, 'https://example.test/mcp')
    assert.equal(servers[0].env[0].value, SECRET)
    const failure = scrubSecretValues(`rejected ${SECRET} and ${HEADER_SECRET}`, servers)
    assert.equal(failure.includes(SECRET), false)
    assert.equal(failure.includes(HEADER_SECRET), false)
  })
})

describe('AcpHost forwardMcp', () => {
  it('sends an empty list unless the option is on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-grok-mcp-'))
    try {
      const entry = {
        options: { name: DSH_MCP_CLIENT },
        disabled: false,
        fiber: {
          state: 2,
          effectiveConfig: { transport: 'stdio', serverName: 'local', command: 'npx', args: [], env: { MCP_TOKEN: SECRET } },
        },
      }
      const ctx = { loader: { entries: () => [entry] } }
      const off = new AcpHost(ctx, { stateFile: join(root, 'off.json'), forwardMcp: false })
      assert.deepEqual(off.sessionMcpServers(), [])
      const on = new AcpHost(ctx, { stateFile: join(root, 'on.json'), forwardMcp: true })
      on.capabilities = { mcpCapabilities: { http: true, sse: true } }
      const servers = on.sessionMcpServers()
      assert.equal(servers.length, 1)
      assert.equal(servers[0].env[0].value, SECRET)
      assert.equal(JSON.stringify(redactMcpServers(servers)).includes(SECRET), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('forwarding failure isolation', () => {
  it('opens a session with no servers when reading the DSH loader throws', async () => {
    const { AcpHost } = await import('../lib/acp-connection.js')
    const warnings = []
    const host = new AcpHost({
      logger: { warn: message => warnings.push(message) },
      get loader() { throw new Error('loader changed') },
    }, { stateFile: 'unused-mcp-state.json', forwardMcp: true })
    host.capabilities = { mcpCapabilities: { http: true } }
    assert.deepEqual(host.sessionMcpServers(), [])
    assert.equal(warnings.length, 1)
  })
})
