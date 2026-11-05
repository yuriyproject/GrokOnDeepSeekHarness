/** One shared Grok ACP stdio process serving every Grok-backed DSH session. */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionMapping } from './mapping.js'
import { permissionOutcome } from './render.js'
import { CONFIG_EFFORT, CONFIG_MODEL, DEFAULT_GROK_MODEL } from './constants.js'
import { errorMessage } from './dsh.js'
import { grokChildEnv, grokProcessCwd } from './grok-env.js'
import { describeToolInput, redactSecrets } from './redact.js'
import { resolveWorkspacePath } from './workspace-path.js'
import { sessionHasFullAccess } from './session-access.js'

const packageVersion = createRequire(import.meta.url)('../package.json').version
const STDERR_TAIL_LINES = 40
/** Largest file the ACP file bridge reads or writes in one request. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024

/** The Grok Build CLI could not be started; the message is meant for the UI. */
export class GrokCliUnavailableError extends Error {
  constructor(command, cause) {
    super(`Grok Build CLI is not available (${command}): ${errorMessage(cause)}. `
      + 'Install Grok Build and sign in with "grok login", or set GROK_COMMAND to the executable.', { cause })
    this.name = 'GrokCliUnavailableError'
    this.command = command
  }
}

class AcpProcess {
  constructor(child, makeClient, disposeGraceMs) {
    if (child.stdin === undefined || child.stdout === undefined) {
      throw new Error('dsh-grok-acp: subprocess dropped a piped ACP stream')
    }
    this.child = child
    this.disposeGraceMs = disposeGraceMs
    this.disposal = undefined
    this.conn = new ClientSideConnection(
      makeClient,
      ndJsonStream(
        NodeWritable.toWeb(child.stdin),
        NodeReadable.toWeb(child.stdout),
      ),
    )
  }

  dispose() {
    return (this.disposal ??= (async () => {
      try {
        this.child.stdin?.end()
      } catch {
        // The pipe may already be closed by the child.
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.disposeGraceMs)
      try {
        if (await this.child.waitForExit(controller.signal)) return
      } catch {
        // Fall through to a forced termination.
      } finally {
        clearTimeout(timer)
      }
      this.child.terminate()
      await this.child.waitForExit().catch(() => {})
    })())
  }
}

export class AcpHost {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.mapping = new SessionMapping(config.stateFile, ctx?.logger)
    this.process = undefined
    this.starting = undefined
    this.agents = new Map()
    this.capabilities = undefined
    this.models = []
    this.currentModelId = DEFAULT_GROK_MODEL
    this.currentEffort = undefined
    this.configOptions = []
    this.commands = []
    this.idleTimer = undefined
    this.generation = 0
    this.reconnections = new WeakMap()
    this.lastError = undefined
    this.stderrTail = []
    this.opening = 0
  }

  get logger() {
    return this.ctx?.logger ?? console
  }

  bindAgent(remoteSessionId, agent) {
    for (const [boundId, boundAgent] of this.agents) {
      if (boundAgent === agent) this.agents.delete(boundId)
    }
    this.agents.set(remoteSessionId, agent)
    agent.attachHost(this, remoteSessionId, this.generation)
  }

  unbindAgent(remoteSessionId) {
    this.agents.delete(remoteSessionId)
    if (this.agents.size === 0 && this.opening === 0) this.scheduleIdleDispose()
  }

  async ensureProcess() {
    this.clearIdleDispose()
    if (this.process !== undefined) return this.process
    if (this.starting !== undefined) return this.starting
    this.starting = this.startProcess().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  /** Resolve the configured command to an executable path, failing with a UI-ready message. */
  async resolveCommand(env) {
    const command = this.config.command
    const subprocess = this.ctx.subprocess
    if (typeof subprocess?.resolveExecutable === 'function') {
      try {
        return await subprocess.resolveExecutable(command, env)
      } catch (error) {
        throw new GrokCliUnavailableError(command, error)
      }
    }
    return command
  }

  async startProcess() {
    this.clearIdleDispose()
    const env = grokChildEnv(this.config)
    const executable = await this.resolveCommand(env)
    let child
    try {
      child = this.ctx.subprocess.spawn({
        argv: [executable, ...this.config.args],
        cwd: grokProcessCwd(),
        env,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: this.config.disposeGraceMs,
      })
    } catch (error) {
      this.lastError = new GrokCliUnavailableError(executable, error)
      throw this.lastError
    }
    this.followStderr(child)
    const processHandle = new AcpProcess(child, () => ({
      sessionUpdate: params => this.handleUpdate(params),
      requestPermission: params => this.requestPermission(params),
      readTextFile: params => this.readTextFile(params),
      writeTextFile: params => this.writeTextFile(params),
      extMethod: (method, params) => this.handleExt(method, params, false),
      extNotification: (method, params) => this.handleExt(method, params, true),
    }), this.config.disposeGraceMs)
    try {
      const initialized = await Promise.race([
        processHandle.conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'dsh-grok-acp', version: packageVersion },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        }),
        child.done.then(() => {
          throw new GrokCliUnavailableError(executable, new Error(`exited before the ACP handshake${this.stderrSummary()}`))
        }),
      ])
      this.capabilities = initialized.agentCapabilities
      this.ingestInitialize(initialized)
      const methods = initialized.authMethods ?? []
      const cached = methods.find(method => method.id === 'cached_token') ?? methods[0]
      if (cached !== undefined) {
        try {
          await processHandle.conn.authenticate({ methodId: cached.id })
        } catch (error) {
          this.logger.warn(`dsh-grok-acp: authenticate(${cached.id}) failed: ${errorMessage(error)}`)
        }
      }
      this.generation += 1
      this.process = processHandle
      this.lastError = undefined
      child.done.catch(() => {}).finally(() => {
        if (this.process !== processHandle) return
        this.process = undefined
        this.capabilities = undefined
        this.logger.warn(`dsh-grok-acp: Grok Build process exited${this.stderrSummary()}`)
      })
      return processHandle
    } catch (error) {
      this.lastError = error instanceof GrokCliUnavailableError ? error : new Error(`Grok Build ACP handshake failed: ${errorMessage(error)}${this.stderrSummary()}`, { cause: error })
      await processHandle.dispose()
      throw this.lastError
    }
  }

  followStderr(child) {
    const stream = child.stderr
    if (stream === undefined || stream === null || typeof stream.on !== 'function') return
    this.stderrTail = []
    let pending = ''
    stream.setEncoding?.('utf8')
    stream.on('data', (chunk) => {
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length === 0) continue
        this.stderrTail.push(line)
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
        this.logger.debug?.(`grok: ${line}`)
      }
    })
    stream.on('error', () => {})
  }

  stderrSummary() {
    if (this.stderrTail.length === 0) return ''
    return `; last output: ${redactSecrets(this.stderrTail.slice(-5).join(' | '))}`
  }

  ingestInitialize(initialized) {
    const meta = initialized._meta ?? {}
    const modelState = meta.modelState ?? {}
    if (typeof modelState.currentModelId === 'string') this.currentModelId = modelState.currentModelId
    if (typeof modelState.reasoningEffort === 'string') this.currentEffort = modelState.reasoningEffort
    if (Array.isArray(modelState.availableModels)) this.models = modelState.availableModels
    if (Array.isArray(meta.availableCommands)) this.commands = meta.availableCommands
  }

  async openSession(localId, cwd, resumeId) {
    if (cwd === undefined || !isAbsolute(cwd)) throw new Error('Grok Build requires an absolute session cwd')
    this.opening += 1
    this.clearIdleDispose()
    try {
      return await this.openSessionInner(localId, cwd, resumeId)
    } finally {
      this.opening -= 1
      if (this.opening === 0 && this.agents.size === 0) this.scheduleIdleDispose()
    }
  }

  async openSessionInner(localId, cwd, resumeId) {
    const processHandle = await this.ensureProcess()
    const mapped = resumeId ?? this.mapping.get(localId)
    const capabilities = this.capabilities ?? {}
    const sessionCaps = capabilities.sessionCapabilities ?? {}
    let remoteSessionId
    let session
    if (mapped !== undefined && sessionCaps.resume !== undefined) {
      try {
        session = await processHandle.conn.resumeSession({ sessionId: mapped, cwd, mcpServers: [] })
        remoteSessionId = mapped
      } catch (error) {
        this.logger.warn(`dsh-grok-acp: resume ${mapped} failed: ${errorMessage(error)}`)
      }
    }
    if (remoteSessionId === undefined && mapped !== undefined && capabilities.loadSession) {
      try {
        session = await processHandle.conn.loadSession({ sessionId: mapped, cwd, mcpServers: [] })
        remoteSessionId = mapped
      } catch (error) {
        this.logger.warn(`dsh-grok-acp: load ${mapped} failed: ${errorMessage(error)}`)
      }
    }
    // A mapped Grok session that can no longer be resumed means Grok has lost its context. The
    // new session is usable, but the caller is told so it can replay the DSH transcript.
    const contextLost = remoteSessionId === undefined && mapped !== undefined
    if (remoteSessionId === undefined) {
      session = await processHandle.conn.newSession({
        cwd,
        mcpServers: [],
        _meta: this.config.yoloMode ? { yoloMode: true } : {},
      })
      remoteSessionId = session.sessionId
    }
    this.mapping.set(localId, remoteSessionId)
    this.ingestSession(session)
    this.clearIdleDispose()
    return { processHandle, remoteSessionId, session, contextLost }
  }

  async ensureAgentSession(agent) {
    if (
      this.process !== undefined
      && agent.hostGeneration === this.generation
      && typeof agent.remoteSessionId === 'string'
    ) {
      return agent.remoteSessionId
    }
    const pending = this.reconnections.get(agent)
    if (pending !== undefined) return pending
    const reconnecting = this.reconnectAgent(agent).finally(() => {
      this.reconnections.delete(agent)
    })
    this.reconnections.set(agent, reconnecting)
    return reconnecting
  }

  async reconnectAgent(agent) {
    const localId = String(agent.id)
    const opened = await this.openSession(localId, agent.session.header.cwd, this.mapping.get(localId))
    this.bindAgent(opened.remoteSessionId, agent)
    if (opened.contextLost) agent.markContextLost?.()
    return opened.remoteSessionId
  }

  ingestSession(session) {
    if (session === undefined || session === null) return
    if (typeof session.models?.currentModelId === 'string') this.currentModelId = session.models.currentModelId
    if (Array.isArray(session.models?.availableModels)) this.models = session.models.availableModels
    const options = session._meta?.['x.ai/sessionConfig']?.options
    if (Array.isArray(options)) {
      const selectedModel = options.find(option => option.category === 'model' && option.selected)
      if (typeof selectedModel?.id === 'string') this.currentModelId = selectedModel.id
    }
    this.ingestConfigOptions(session.configOptions)
  }

  ingestConfigOptions(options) {
    if (!Array.isArray(options)) return
    this.configOptions = options
    const model = options.find(option => option.id === CONFIG_MODEL || option.category === 'model')
    if (typeof model?.currentValue === 'string') this.currentModelId = model.currentValue
    const effort = options.find(option => option.id === CONFIG_EFFORT || option.category === 'thought_level')
    if (typeof effort?.currentValue === 'string') this.currentEffort = effort.currentValue
  }

  async closeSession(localId, remoteSessionId) {
    this.unbindAgent(remoteSessionId)
    const conn = this.process?.conn
    if (conn === undefined || remoteSessionId === undefined) return
    try {
      if (this.capabilities?.sessionCapabilities?.close !== undefined) {
        await conn.closeSession({ sessionId: remoteSessionId })
      }
    } catch {
      // The child may already be gone.
    }
  }

  handleUpdate(params) {
    this.applyGlobalUpdate(params)
    const agent = this.agents.get(params.sessionId)
    return agent?.handleUpdate(params) ?? Promise.resolve()
  }

  applyGlobalUpdate(params) {
    const update = params.update
    if (update?.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      this.commands = update.availableCommands
    }
    if (update?.sessionUpdate === 'model_changed' && typeof update.currentModelId === 'string') {
      this.currentModelId = update.currentModelId
    }
    if (update?.sessionUpdate === 'config_option_update') this.ingestConfigOptions(update.configOptions)
  }

  async handleExt(method, params, notification) {
    const modelId = params?.currentModelId ?? params?.modelId
    if (typeof modelId === 'string' && method.includes('models')) this.currentModelId = modelId
    if (Array.isArray(params?.availableModels)) this.models = params.availableModels
    if (Array.isArray(params?.availableCommands)) this.commands = params.availableCommands
    if (typeof params?.sessionId === 'string') {
      const agent = this.agents.get(params.sessionId)
      agent?.handleExt?.(method, params)
    }
    return notification ? undefined : {}
  }

  async requestPermission(params) {
    const agent = this.agents.get(params.sessionId)
    if (agent === undefined) return { outcome: { outcome: 'cancelled' } }
    if (sessionHasFullAccess(agent.session)) {
      agent.turnApprovals = (agent.turnApprovals ?? 0) + 1
      return permissionOutcome('allowed-once', params.options)
    }
    try {
      const toolCall = params.toolCall ?? {}
      const detail = describeToolInput(toolCall)
      const outcome = await this.ctx.approval.request({
        agent,
        toolName: toolCall.title || toolCall.kind || 'Grok Build',
        callId: ToolCallId(String(toolCall.toolCallId ?? 'grok-permission')),
        reason: detail.length > 0 ? detail : (toolCall.title || 'Grok Build permission request'),
      })
      if (outcome === 'allowed-once') agent.turnApprovals = (agent.turnApprovals ?? 0) + 1
      return permissionOutcome(outcome, params.options)
    } catch (error) {
      this.logger.warn(`dsh-grok-acp: permission prompt failed: ${errorMessage(error)}`)
      return { outcome: { outcome: 'cancelled' } }
    }
  }

  /**
   * File writes through the client file system normally follow a permission the user already
   * answered in the same turn. When Grok writes without one (its own auto-approve setting), ask
   * through DSH instead of writing silently.
   */
  async requireWriteApproval(agent, path) {
    if (agent === undefined || sessionHasFullAccess(agent.session)) return
    if ((agent.turnApprovals ?? 0) > 0) return
    const outcome = await this.ctx.approval.request({
      agent,
      toolName: 'Write file',
      callId: ToolCallId(`grok-fs-write:${Date.now()}`),
      reason: `Grok Build wants to write ${path}`,
    })
    if (outcome !== 'allowed-once') throw new Error(`writing ${path} was not approved`)
  }

  async readTextFile(params) {
    const path = await this.resolveFilePath(params.path, params.sessionId, 'read')
    const info = await stat(path)
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`file is too large for the ACP file bridge (${info.size} bytes, limit ${MAX_FILE_BYTES})`)
    }
    const content = await readFile(path, 'utf8')
    if (params.line === undefined && params.limit === undefined) return { content }
    const lines = content.split('\n')
    const start = Math.max((params.line ?? 1) - 1, 0)
    const slice = params.limit === undefined ? lines.slice(start) : lines.slice(start, start + params.limit)
    return { content: slice.join('\n') }
  }

  async writeTextFile(params) {
    const content = params.content ?? ''
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new Error(`content is too large for the ACP file bridge (limit ${MAX_FILE_BYTES} bytes)`)
    }
    const path = await this.resolveFilePath(params.path, params.sessionId, 'write')
    await this.requireWriteApproval(this.agents.get(params.sessionId), path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    return {}
  }

  async resolveFilePath(path, sessionId, operation) {
    const session = this.agents.get(sessionId)?.session
    const cwd = session?.header?.cwd
    const allowOutsideWorkspace = this.config.allowOutsideWorkspace || sessionHasFullAccess(session)
    return resolveWorkspacePath(path, cwd, operation, allowOutsideWorkspace)
  }

  async setConfigOption(remoteSessionId, configId, value) {
    const conn = this.process?.conn
    if (conn === undefined) throw new Error('Grok ACP is not running')
    const response = await conn.setSessionConfigOption({ sessionId: remoteSessionId, configId, value })
    this.ingestConfigOptions(response?.configOptions)
    if (configId === CONFIG_MODEL && typeof value === 'string') this.currentModelId = value
    if (configId === CONFIG_EFFORT && typeof value === 'string') this.currentEffort = value
    return response
  }

  extMethod(method, params) {
    const conn = this.process?.conn
    if (conn === undefined) throw new Error('Grok ACP is not running')
    return conn.extMethod(method, params)
  }

  prompt(params) {
    const conn = this.process?.conn
    if (conn === undefined) throw new Error('Grok ACP is not running')
    return conn.prompt(params)
  }

  cancel(params) {
    const conn = this.process?.conn
    if (conn === undefined) return Promise.resolve()
    return conn.cancel(params).catch(() => {})
  }

  scheduleIdleDispose() {
    this.clearIdleDispose()
    const idleMs = this.config.idleDisposeMs
    if (!idleMs || idleMs <= 0) return
    this.idleTimer = setTimeout(() => {
      if (this.agents.size === 0 && this.opening === 0) void this.disposeProcess()
    }, idleMs)
  }

  clearIdleDispose() {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }

  async disposeProcess() {
    const processHandle = this.process
    this.process = undefined
    this.capabilities = undefined
    if (processHandle !== undefined) await processHandle.dispose()
  }

  async dispose() {
    this.clearIdleDispose()
    this.agents.clear()
    await this.disposeProcess()
  }
}
