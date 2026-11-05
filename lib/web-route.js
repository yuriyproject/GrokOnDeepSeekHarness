/** Same-origin HTTP bridge for the composer harness picker. */

import { SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_DSH_PRESET, GROK_PRESET_ID, isGrokPreset, SESSION_ROUTE } from './constants.js'
import { CLIENT_OWNED_COMMANDS, WEB_COMMANDS } from './preset-marker.js'
import { errorMessage, sessionBlank } from './dsh.js'
export { isTrustedRequest, sessionHandler } from './http-route.js'

export { SESSION_ROUTE }

export function snapshotFor(ctx, session, router, host, resolvePreset, dshPresets = []) {
  const preset = resolvePreset(session) ?? DEFAULT_DSH_PRESET
  const grok = isGrokPreset(preset)
  const record = router.recordFor(session.id)
  const models = grokModelRows(host)
  return {
    sessionId: String(session.id),
    harness: grok ? 'grok-build' : 'dsh',
    preset,
    dshPreset: grok ? router.lastDsh(session.id) : preset,
    blank: sessionBlank(ctx, session),
    running: record?.underlying.agent.status === 'running',
    dshPresets,
    grok: {
      ready: host.process !== undefined,
      command: host.config.command,
      error: host.lastError === undefined ? undefined : errorMessage(host.lastError),
      model: record?.underlying.agent.grokModel ?? host.currentModelId,
      models,
      effort: currentGrokEffort(host, models),
      commands: grok ? grokCommandRows(host) : [],
    },
  }
}

export function parseSessionId(value) {
  return SessionId(String(value))
}

function grokModelRows(host) {
  return (host.models ?? []).map((model) => {
    const id = model.modelId ?? model.id
    if (typeof id !== 'string') return undefined
    const meta = model._meta ?? {}
    const efforts = Array.isArray(meta.reasoningEfforts)
      ? meta.reasoningEfforts.map(effort => ({
        id: String(effort.id ?? effort.value ?? ''),
        label: String(effort.label ?? effort.id ?? effort.value ?? ''),
      })).filter(effort => effort.id.length > 0)
      : []
    return {
      id,
      name: model.name ?? id,
      description: typeof model.description === 'string' ? model.description : undefined,
      effort: typeof meta.reasoningEffort === 'string' ? meta.reasoningEffort : undefined,
      efforts,
    }
  }).filter(model => model !== undefined)
}

function currentGrokEffort(host, models) {
  if (typeof host.currentEffort === 'string') return host.currentEffort
  const current = models.find(model => model.id === host.currentModelId)
  return current?.effort
}

function grokCommandRows(host) {
  const fromAgent = Array.isArray(host.commands) ? host.commands : []
  const names = new Set()
  const rows = []
  for (const command of [...WEB_COMMANDS, ...fromAgent]) {
    if (typeof command?.name !== 'string' || CLIENT_OWNED_COMMANDS.has(command.name) || names.has(command.name)) continue
    names.add(command.name)
    rows.push({
      name: command.name,
      description: command.description ?? '',
      hint: command.input?.hint,
    })
  }
  return rows
}
