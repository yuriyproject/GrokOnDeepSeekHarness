/** Grok Build ACP as a selectable root harness inside DeepSeek Harness Web (DSH 0.2.2). */

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { AcpHost } from './acp-connection.js'
import {
  CONFIG_EFFORT,
  CONFIG_MODEL,
  DEFAULT_DSH_PRESET,
  GROK_PRESET_ID,
  GROK_PRESET_ORDER,
  PLUGIN_NAME,
  isGrokPreset,
  SESSION_ROUTE,
} from './constants.js'
import { errorMessage, sessionBlank, unwrapService } from './dsh.js'
import { defaultGrokCommand, defaultGrokHome } from './grok-env.js'
import { GrokAgentFactory } from './grok-agent.js'
import { HarnessRouterFactory } from './router.js'
import { parseSessionId, sessionHandler, snapshotFor } from './web-route.js'

export const name = PLUGIN_NAME
export const inject = [
  'agents', 'agentPresets', 'sessions', 'sessionPersistence', 'sessionProjections',
  'subprocess', 'approval', 'commands',
]

function defaultStateFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'grok-harness-sessions.json')
}

export const Config = z.object({
  /** Grok Build executable: `GROK_COMMAND`, else `~/.grok/bin/grok`, else `grok` on PATH. */
  command: z.string().default(defaultGrokCommand()),
  args: z.array(z.string()).default(['agent', '--no-leader', 'stdio']),
  /** Grok state directory (`GROK_HOME`): auth, sessions and logs stay inside it. */
  grokHome: z.string().default(defaultGrokHome() ?? ''),
  /** Extra environment for the Grok process. `XAI_API_KEY` is never forwarded. */
  env: z.dict(z.string()).default({}),
  stateFile: z.string().default(defaultStateFile()),
  disposeGraceMs: z.number().default(6_000),
  idleDisposeMs: z.number().default(30_000),
  yoloMode: z.boolean().default(false),
  allowOutsideWorkspace: z.boolean().default(false),
  /** Display name and description of the Grok preset row registered when no YAML row declares it. */
  presetName: z.string().default('Grok Build'),
  presetDescription: z.string().default('Grok Build through ACP (OAuth login of the Grok CLI). The DSH / Grok Build switch sits next to the composer.'),
})

export function apply(ctx, rawConfig) {
  const config = { ...rawConfig, command: rawConfig.command && rawConfig.command.length > 0 ? rawConfig.command : defaultGrokCommand(), grokHome: rawConfig.grokHome && rawConfig.grokHome.length > 0 ? rawConfig.grokHome : undefined }
  const agents = unwrapService(ctx.agents)
  const originalSlot = agents.factory
  if (originalSlot?.target === undefined) {
    throw new Error('dsh-grok-acp requires the official DSH agent-loop to load first')
  }

  const host = new AcpHost(ctx, config)
  const grokFactory = new GrokAgentFactory(ctx, config, host)
  const router = new HarnessRouterFactory(ctx, originalSlot.target, grokFactory)
  agents.factory = { target: router }

  // The preset normally comes from cordis.patch.yml (an `@deepseek-ai/dsh-agent-preset`
  // row); register it here only when the deployment omitted that row.
  let unregisterPreset
  void (async () => {
    try {
      const listed = await ctx.agentPresets.list()
      if (listed.some(preset => preset.id === GROK_PRESET_ID)) return
      unregisterPreset = await ctx.agentPresets.register({
        id: GROK_PRESET_ID,
        name: config.presetName,
        description: config.presetDescription,
        order: GROK_PRESET_ORDER,
        plugins: [{ id: 'grok-build-harness', name: `${PLUGIN_NAME}/preset-marker` }],
      })
    } catch (error) {
      ctx.logger.warn(`dsh-grok-acp: cannot register the ${GROK_PRESET_ID} preset: ${errorMessage(error)}`)
    }
  })()

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: SESSION_ROUTE,
      handler: sessionHandler({
        read: async (sessionId) => readSnapshot(ctx, router, host, sessionId),
        write: async (input) => writeSnapshot(ctx, router, host, input),
      }),
    }), 'dsh-grok-acp: session route')
  })

  return async () => {
    if (agents.factory?.target === router) agents.factory = originalSlot
    await unregisterPreset?.()
    await router.dispose()
    await host.dispose()
  }
}

function presetResolver(ctx) {
  return (session) => {
    const projected = ctx.agentPresets.presetForSession?.(session)
    if (typeof projected === 'string') return projected
    return session.header?.agentPreset ?? ctx.agentPresets.defaultId
  }
}

async function readSnapshot(ctx, router, host, rawId) {
  const sessionId = parseSessionId(rawId)
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error(`unknown session ${rawId}`)
  const dshPresets = (await ctx.agentPresets.list())
    .filter(preset => !isGrokPreset(preset.id) && preset.broken === undefined)
    .map(preset => ({
      id: preset.id,
      name: preset.name ?? preset.id,
      description: preset.description ?? '',
    }))
  return snapshotFor(ctx, session, router, host, presetResolver(ctx), dshPresets)
}

async function writeSnapshot(ctx, router, host, input) {
  if (input === null || typeof input !== 'object') throw new Error('invalid payload')
  const sessionId = parseSessionId(input.sessionId)
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error(`unknown session ${input.sessionId}`)
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error(`no agent for session ${input.sessionId}`)
  const resolvePreset = presetResolver(ctx)
  if (input.harness !== undefined) {
    if (!sessionBlank(ctx, session)) throw new Error('The harness cannot change after the session has started')
    const harness = input.harness === 'grok-build' ? GROK_PRESET_ID : (router.lastDsh(sessionId) || DEFAULT_DSH_PRESET)
    if (isGrokPreset(harness) !== isGrokPreset(resolvePreset(session))) {
      if (isGrokPreset(harness)) {
        // Fail early with a readable message when the CLI is missing instead of
        // leaving the session half-switched.
        await host.ensureProcess()
      }
      await ctx.agentPresets.select(agent, harness)
      const record = router.recordFor(sessionId)
      if (record !== undefined) await record.transition
    }
  }
  if (input.preset !== undefined) {
    if (!sessionBlank(ctx, session)) throw new Error('The agent preset cannot change after the session has started')
    if (typeof input.preset !== 'string' || isGrokPreset(input.preset)) {
      throw new Error('invalid DSH Agent preset')
    }
    const live = ctx.agents.get(sessionId) ?? agent
    await ctx.agentPresets.select(live, input.preset)
  }
  if (input.modelId !== undefined || input.effort !== undefined) {
    const record = router.recordFor(sessionId)
    if (record?.mode !== GROK_PRESET_ID) {
      throw new Error('Only Grok Build sessions can change the model and reasoning effort')
    }
    const remote = await host.ensureAgentSession(record.underlying.agent)
    if (input.modelId !== undefined) {
      if (typeof input.modelId !== 'string') throw new Error('invalid model id')
      await host.setConfigOption(remote, CONFIG_MODEL, input.modelId)
      record.underlying.agent.grokModel = input.modelId
    }
    if (input.effort !== undefined) {
      if (typeof input.effort !== 'string') throw new Error('invalid reasoning effort')
      await host.setConfigOption(remote, CONFIG_EFFORT, input.effort)
    }
  }
  return await readSnapshot(ctx, router, host, input.sessionId)
}
