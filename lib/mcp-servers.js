/** Map DSH MCP client configs onto ACP `session/*` `mcpServers` without logging secrets. */

import { redactSecrets } from './redact.js'

/** Profile rows that connect one external MCP server. */
export const DSH_MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

/**
 * Resolved configs of active host-loader `@deepseek-ai/dsh-mcp-client` rows.
 * Agent-preset trees are not children of this loader, so they are not included.
 * The objects are the live configs; callers must not log them.
 * @param {object} ctx Plugin context.
 * @returns {object[]}
 */
export function readDshMcpDefinitions(ctx) {
  const loader = ctx?.loader ?? ctx?.get?.('loader')
  if (typeof loader?.entries !== 'function') return []
  const definitions = []
  for (const entry of loader.entries()) {
    if (entry?.options?.name !== DSH_MCP_CLIENT) continue
    if (entry.disabled) continue
    if (entry.fiber?.state !== 2) continue
    const config = entry.fiber.effectiveConfig
    if (config === null || typeof config !== 'object') continue
    definitions.push(config)
  }
  return definitions
}

/**
 * Convert DSH MCP definitions to ACP `McpServer` objects.
 * Stdio is always eligible. `http` and `sse` are included only when Grok advertises them.
 * Empty names and unknown transports are dropped. Later duplicates of a name are dropped.
 * @param {object[]} definitions
 * @param {{ http?: boolean, sse?: boolean }} [capabilities]
 * @returns {object[]}
 */
export function toAcpMcpServers(definitions, capabilities = {}) {
  const servers = []
  const names = new Set()
  for (const definition of definitions ?? []) {
    const server = oneServer(definition, capabilities)
    if (server === undefined) continue
    if (names.has(server.name)) continue
    names.add(server.name)
    servers.push(server)
  }
  return servers
}

/**
 * Copy of ACP servers safe to log. Env and header values become `***`.
 * URL userinfo and query strings are removed. The input is not mutated.
 * @param {object[]} servers
 * @returns {object[]}
 */
export function redactMcpServers(servers) {
  return (servers ?? []).map((server) => {
    const copy = { ...server }
    if (typeof copy.url === 'string') copy.url = redactUrl(copy.url)
    if (Array.isArray(copy.args)) copy.args = copy.args.map((arg) => redactSecrets(String(arg)))
    if (Array.isArray(copy.env)) copy.env = copy.env.map((entry) => ({ name: entry.name, value: '***' }))
    if (Array.isArray(copy.headers)) copy.headers = copy.headers.map((entry) => ({ name: entry.name, value: '***' }))
    return copy
  })
}

/**
 * Replace env and header values that appear in free text. Used for error logs,
 * which can echo the request. Values shorter than 6 characters are left alone.
 * @param {string} text
 * @param {object[]} servers Unredacted ACP servers.
 * @returns {string}
 */
export function scrubSecretValues(text, servers) {
  let out = String(text)
  for (const server of servers ?? []) {
    for (const entry of [...(server.env ?? []), ...(server.headers ?? [])]) {
      const value = entry?.value
      if (typeof value !== 'string' || value.length < 6) continue
      out = out.split(value).join('***')
    }
  }
  return out
}

function oneServer(definition, capabilities) {
  if (definition === null || typeof definition !== 'object') return undefined
  const name = typeof definition.serverName === 'string'
    ? definition.serverName.trim()
    : (typeof definition.name === 'string' ? definition.name.trim() : '')
  if (name.length === 0) return undefined
  const transport = definition.transport
  if (transport === 'stdio') return stdioServer(name, definition)
  if (transport === 'streamable-http' || transport === 'http') {
    if (capabilities.http !== true) return undefined
    return httpServer('http', name, definition)
  }
  if (transport === 'sse') {
    if (capabilities.sse !== true) return undefined
    return httpServer('sse', name, definition)
  }
  return undefined
}

function stdioServer(name, definition) {
  if (typeof definition.command !== 'string' || definition.command.length === 0) return undefined
  return {
    name,
    command: definition.command,
    args: stringList(definition.args),
    env: nameValueList(definition.env),
  }
}

function httpServer(type, name, definition) {
  if (typeof definition.url !== 'string' || definition.url.length === 0) return undefined
  return {
    type,
    name,
    url: definition.url,
    headers: nameValueList(definition.headers),
  }
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string')
}

function nameValueList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry?.name !== 'string' || entry.name.length === 0) return []
      if (typeof entry.value !== 'string') return []
      return [{ name: entry.name, value: entry.value }]
    })
  }
  if (value === null || typeof value !== 'object') return []
  const entries = []
  for (const [name, entry] of Object.entries(value)) {
    if (name.length === 0 || typeof entry !== 'string') continue
    entries.push({ name, value: entry })
  }
  return entries
}

function redactUrl(url) {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return '***'
  }
}
