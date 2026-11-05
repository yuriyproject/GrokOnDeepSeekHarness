/** DSH Agent whose turns are driven by Grok Build over ACP (DSH 0.2.x Agent contract). */

import {
  AgentModel,
  agentEvents,
  modelSelectionProjectionDefinition,
} from '@deepseek-ai/dsh-agent'
import {
  AssistantStreamAccumulator,
  LlmAttemptId,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  errorChain,
} from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionLogOffset, SessionPreparation, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { CONFIG_EFFORT, CONFIG_MODEL, DEFAULT_GROK_MODEL, GROK_PRESET_ID } from './constants.js'
import {
  GROK_ACTIVITY_TOOL,
  activityFallback,
  activityMeta,
  classifyActivityTool,
  createActivityState,
} from './activity.js'
import { CLIENT_OWNED_COMMANDS, WEB_COMMANDS, WITHHELD_COMMANDS, commandHandler } from './preset-marker.js'
import { errorMessage, sessionEvents } from './dsh.js'
import { GrokInbox } from './inbox.js'
import {
  renderBilling,
  renderContext,
  planTodos,
  renderSessionInfo,
  renderToolOutput,
  toAcpPrompt,
  transcriptForReplay,
} from './render.js'

export class GrokWebAgent {
  constructor(hostCtx, id, options, session, projections, lastTurn) {
    this.hostCtx = hostCtx
    this.id = id
    this.options = options
    this.session = session
    this.dispatch = agentEvents(hostCtx, this)
    this.inbox = new GrokInbox(session, {
      inserted: message => this.dispatch.emit('agent/inbox/inserted', { message }),
      discarded: message => this.dispatch.emit('agent/inbox/discarded', { message }),
      claimed: (message, turn) => this.dispatch.emit('agent/inbox/claimed', { message, turn }),
    })
    this.scope = createScope(hostCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    // The DSH composer treats the session as routable through its own model
    // selection; Grok's model lives on the ACP session and the harness control.
    this.model = new AgentModel(projections.modelSelection, session, options)
    this.phase = { kind: 'idle' }
    this.idle = Promise.resolve()
    this.active = undefined
    this.host = undefined
    this.remoteSessionId = undefined
    this.hostGeneration = undefined
    this.lastTurn = lastTurn
    this.streamRevision = 0
    this.attemptCounter = 0
    this.sessionInfo = undefined
    this.availableCommands = []
    this.grokModel = DEFAULT_GROK_MODEL
    this.turnApprovals = 0
    this.contextLost = false
  }

  /** Grok could not resume its earlier session: the next prompt carries a replay of the DSH transcript. */
  markContextLost() {
    this.contextLost = true
  }

  get status() {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  attachHost(host, remoteSessionId, generation) {
    this.host = host
    this.remoteSessionId = remoteSessionId
    this.hostGeneration = generation
  }

  async runWebCommand(name, rawInput) {
    const host = this.host
    if (host === undefined) {
      return { kind: 'error', text: 'Grok ACP session is unavailable' }
    }
    let remoteSessionId
    try {
      remoteSessionId = await host.ensureAgentSession(this)
    } catch (error) {
      return { kind: 'error', text: errorChain(error) }
    }
    if (name === 'usage' || name === 'cost' || name === 'uasge') {
      try {
        const response = await host.extMethod('_x.ai/billing', {})
        return { kind: 'success', text: renderBilling(response) }
      } catch (error) {
        return { kind: 'error', text: errorChain(error) }
      }
    }
    if (name === 'btw') {
      const question = rawInput.trim()
      if (question.length === 0) return { kind: 'error', text: 'Usage: /btw <question>' }
      try {
        const response = await host.extMethod('_x.ai/btw', { sessionId: remoteSessionId, question })
        const answer = response?.result?.answer ?? response?.answer
        return typeof answer === 'string'
          ? { kind: 'success', text: answer }
          : { kind: 'error', text: 'Grok Build returned no BTW answer' }
      } catch (error) {
        return { kind: 'error', text: errorChain(error) }
      }
    }
    if (name === 'context') {
      try {
        const response = await host.extMethod('_x.ai/session/info', { sessionId: remoteSessionId })
        return { kind: 'success', text: renderContext(response?.result ?? response) }
      } catch (error) {
        return { kind: 'error', text: errorChain(error) }
      }
    }
    if (name === 'session-info' || name === 'status' || name === 'info') {
      try {
        const response = await host.extMethod('_x.ai/session/info', { sessionId: remoteSessionId })
        return { kind: 'success', text: renderSessionInfo(response?.result ?? response) }
      } catch (error) {
        return { kind: 'error', text: errorChain(error) }
      }
    }
    if (name === 'model' || name === 'models' || name === 'grok-model' || name === 'effort') {
      const value = rawInput.trim()
      const isModel = name !== 'effort'
      if (value.length === 0) {
        return {
          kind: 'success',
          text: isModel
            ? `Current model: ${this.grokModel ?? host.currentModelId}\nAvailable: ${(host.models ?? []).map(model => model.modelId ?? model.id).join(', ')}`
            : `Current effort: ${host.currentEffort ?? 'unknown'}\nUsage: /effort low|medium|high|xhigh`,
        }
      }
      try {
        await host.setConfigOption(remoteSessionId, isModel ? CONFIG_MODEL : CONFIG_EFFORT, value)
        if (isModel) this.grokModel = value
        return { kind: 'success', text: `Switched to ${value}` }
      } catch (error) {
        return { kind: 'error', text: errorChain(error) }
      }
    }
    const line = `/${name}${rawInput.length > 0 && !rawInput.startsWith(' ') ? ' ' : ''}${rawInput}`
    this.followup(createUserMessage({
      content: [{ type: 'text', text: line }],
      source: { kind: 'user' },
    }))
    return { kind: 'success' }
  }

  send(message, target, wakeup) {
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    this.inbox.append(wakingAfterAbort ? 'next-turn' : target, message)
    if (!wakeup) return
    if (this.phase.kind === 'idle') this.wake()
    else if (this.phase.kind === 'maintenance' || wakingAfterAbort) this.phase.wakeRequested = true
  }

  followup(message) { this.send(message, 'next-turn', true) }
  steer(message) { this.send(message, 'next-turn', true) }
  inject(message) { this.send(message, 'next-step', false) }

  cancel(cause, options = {}) {
    if (!options.keepInbox) this.inbox.clear()
    if (this.phase.kind === 'idle') return
    this.phase.wakeRequested = false
    this.phase.abort.abort(cause)
    if (this.remoteSessionId !== undefined) {
      void this.host?.cancel({ sessionId: this.remoteSessionId })
    }
  }

  async whenIdle() {
    let activity
    do {
      await (activity = this.idle)
    } while (activity !== this.idle)
  }

  runMaintenance(task) {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const phase = { kind: 'maintenance', abort: new AbortController(), wakeRequested: false }
    this.phase = phase
    const result = Promise.resolve().then(() => task(phase.abort.signal))
    this.idle = result.then(() => {}, () => {}).finally(() => {
      this.phase = { kind: 'idle' }
      if (phase.wakeRequested && this.inbox.nextTurn.length > 0) this.wake()
    })
    return result
  }

  wake() {
    const abort = new AbortController()
    this.phase = { kind: 'running', abort, wakeRequested: false }
    this.dispatch.emit('agent/status', { status: 'running' })
    this.idle = this.drain(abort)
  }

  async drain(initial) {
    let abort = initial
    try {
      while (true) {
        await this.drive(abort.signal)
        if (this.inbox.nextTurn.length === 0) return
        abort = new AbortController()
        this.phase = { kind: 'running', abort, wakeRequested: false }
      }
    } finally {
      this.phase = { kind: 'idle' }
      this.dispatch.emit('agent/status', { status: 'idle' })
    }
  }

  async drive(signal) {
    while (this.inbox.nextTurn.length > 0) {
      const turn = ++this.lastTurn
      let reason = { kind: 'completed' }
      const turnStart = this.session.append('turn/start', { turn })
      this.turnApprovals = 0
      const active = createTurnState(turn)
      this.active = active
      try {
        const messages = this.inbox.claim('next-turn', turn)
        for (const message of messages) {
          this.session.append('user/message', message, { surfaceOp: 'append' })
        }
        signal.throwIfAborted()
        if (this.host === undefined) {
          throw new Error('Grok ACP session is unavailable')
        }
        this.remoteSessionId = await this.host.ensureAgentSession(this)
        const prompt = messages.flatMap(message => toAcpPrompt(message.content))
        if (prompt.length === 0) prompt.push({ type: 'text', text: '' })
        if (this.contextLost) {
          const history = transcriptForReplay(sessionEvents(this.session), turnStart.seq)
          if (history.length > 0) {
            prompt.unshift({
              type: 'text',
              text: '[DSH restored this conversation because your previous session could not be resumed. '
                + 'The earlier messages follow for context only. Do not answer them again; '
                + 'respond to the message after the marker.]\n\n' + history + '\n\n[end of restored conversation]\n',
            })
          }
          this.contextLost = false
        }
        const response = await abortable(this.host.prompt({ sessionId: this.remoteSessionId, prompt }), signal, this.promptAbortGraceMs ?? 3_000)
        signal.throwIfAborted()
        this.finishTurn(active, false)
        if (response.stopReason === 'max_tokens') reason = { kind: 'max-tokens' }
        else if (response.stopReason === 'cancelled') reason = { kind: 'aborted', reason: abortCause(signal) }
        else if (response.stopReason === 'refusal') reason = { kind: 'error', error: { message: 'Grok refused the request', code: 'GROK_REFUSAL' } }
      } catch (error) {
        try {
          this.finishTurn(active, true, signal.aborted ? 'Grok turn cancelled' : errorChain(error))
        } catch (cleanup) {
          this.hostCtx.logger?.warn?.(`dsh-grok-acp: could not close turn ${turn}: ${errorMessage(cleanup)}`)
        }
        reason = signal.aborted
          ? { kind: 'aborted', reason: abortCause(signal) }
          : { kind: 'error', error: { message: errorChain(error), code: 'GROK_ACP_ERROR' } }
        this.dispatch.emit('agent/error', { turn, step: active.nextStep - 1, error })
      } finally {
        this.active = undefined
        this.session.append('turn/end', { turn, reason })
      }
      if (signal.aborted) return
    }
  }

  // ── assistant stream: live frames for the browser, durable snapshot on commit ──

  emitStreamFrame(frame) {
    this.dispatch.emit('agent/assistant-stream', { frame: { ...frame, revision: ++this.streamRevision } })
  }

  startAssistantStream(step) {
    step.stream = {
      accumulator: new AssistantStreamAccumulator(),
      attemptId: LlmAttemptId(`${String(this.id)}:${++this.attemptCounter}`),
      index: 0,
      ended: false,
    }
    this.emitStreamFrame({ type: 'start', attemptId: step.stream.attemptId, turn: step.turn, step: step.step })
  }

  publishChunk(step, chunk) {
    const stream = step.stream
    if (stream === undefined) return
    const timed = stream.accumulator.push({ time: Date.now(), chunk })
    this.emitStreamFrame({
      type: 'chunk',
      attemptId: stream.attemptId,
      index: stream.index++,
      time: timed?.time ?? Date.now(),
      chunk: timed?.chunk ?? chunk,
    })
  }

  endAssistantStream(step, outcome) {
    const stream = step.stream
    if (stream === undefined || stream.ended) return
    stream.ended = true
    this.emitStreamFrame({ type: 'end', attemptId: stream.attemptId, index: stream.index, outcome })
  }

  closeAssistantBlocks(step) {
    if (step.reasoningIndex !== undefined && step.reasoningStarted) {
      this.publishChunk(step, {
        type: 'block-end', index: step.reasoningIndex, block: { type: 'reasoning', text: step.reasoning },
      })
      step.reasoningStarted = false
    }
    if (step.textIndex !== undefined && step.textStarted) {
      this.publishChunk(step, {
        type: 'block-end', index: step.textIndex, block: { type: 'text', text: step.text },
      })
      step.textStarted = false
    }
  }

  /**
   * Durably commit the step's assistant message. DSH requires every `tool/call`
   * to be advertised by an assistant `tool-call` block of the same step, so the
   * tools this step is about to run are appended to the message here.
   */
  commitAssistant(step, interrupted, tools = []) {
    if (step.assistantCommitted) return
    step.assistantCommitted = true
    this.closeAssistantBlocks(step)
    const blocks = []
    if (step.reasoning.length > 0) blocks.push({ index: step.reasoningIndex ?? 0, block: { type: 'reasoning', text: step.reasoning } })
    if (step.text.length > 0) blocks.push({ index: step.textIndex ?? 0, block: { type: 'text', text: step.text } })
    for (const tool of tools) {
      const index = step.nextBlockIndex++
      const block = { type: 'tool-call', id: tool.id, name: tool.name, arguments: tool.arguments }
      this.publishChunk(step, { type: 'block-start', index, blockType: 'tool-call' })
      this.publishChunk(step, { type: 'tool-call-delta', index, id: tool.id, name: tool.name, argumentsDelta: tool.arguments })
      this.publishChunk(step, { type: 'block-end', index, block })
      blocks.push({ index, block })
    }
    blocks.sort((a, b) => a.index - b.index)
    const content = blocks.map(entry => entry.block)
    const stream = step.stream?.accumulator.snapshot() ?? []
    try {
      let settled
      if (content.length > 0) {
        settled = this.session.append('assistant/message', {
          turn: step.turn,
          step: step.step,
          message: createAssistantMessage({
            content,
            source: { provider: 'grok-build', model: this.grokModel ?? DEFAULT_GROK_MODEL },
          }),
          stream,
          ...(interrupted ? { interrupted: true } : {}),
        }, { surfaceOp: 'append' })
        this.endAssistantStream(step, { kind: 'committed', eventType: 'assistant/message', seq: settled.seq })
      } else if (step.stream !== undefined) {
        settled = this.session.append('assistant/attempt', { turn: step.turn, step: step.step, stream })
        this.endAssistantStream(step, { kind: 'committed', eventType: 'assistant/attempt', seq: settled.seq })
      }
    } catch (error) {
      this.endAssistantStream(step, { kind: 'abandoned' })
      throw error
    }
  }

  // ── steps: one open step at a time, closed once its tool lifecycle is settled ──

  ensureStep(active) {
    if (active.step !== undefined) return active.step
    const n = active.nextStep++
    this.session.append('step/start', { turn: active.turn, step: n })
    const step = {
      turn: active.turn,
      step: n,
      text: '',
      reasoning: '',
      textStarted: false,
      reasoningStarted: false,
      textIndex: undefined,
      reasoningIndex: undefined,
      nextBlockIndex: 0,
      stream: undefined,
      assistantCommitted: false,
    }
    this.startAssistantStream(step)
    active.step = step
    return step
  }

  endStep(active, interrupted = false) {
    const step = active.step
    if (step === undefined) return
    if (!step.assistantCommitted) this.commitAssistant(step, interrupted)
    this.session.append('step/end', { turn: step.turn, step: step.step })
    active.step = undefined
    this.replayDeferred(active)
  }

  replayDeferred(active) {
    const deferred = active.deferred.splice(0)
    for (const chunk of deferred) this.appendText(active, chunk.kind, chunk.text)
  }

  /** Route streamed text: held back while tools own the lane, otherwise appended to the open step. */
  appendText(active, kind, text) {
    if (typeof text !== 'string' || text.length === 0) return
    // Text must not close a group whose tools are still running: finishing it would record the
    // real results as failures. Hold the text until the lane is quiet.
    const busy = active.edit !== undefined
      || active.queue.length > 0
      || (active.group !== undefined && active.group.pending > 0)
    if (busy) {
      active.deferred.push({ kind, text })
      return
    }
    if (active.group !== undefined) this.finishGroup(active)
    this.appendTextDelta(this.ensureStep(active), kind, text)
  }

  appendTextDelta(step, kind, text) {
    if (typeof text !== 'string' || text.length === 0) return
    const isReasoning = kind === 'reasoning'
    const indexKey = isReasoning ? 'reasoningIndex' : 'textIndex'
    const startedKey = isReasoning ? 'reasoningStarted' : 'textStarted'
    const blockType = isReasoning ? 'reasoning' : 'text'
    const deltaType = isReasoning ? 'reasoning-delta' : 'text-delta'
    if (!step[startedKey]) {
      const index = step.nextBlockIndex++
      step[startedKey] = true
      step[indexKey] = index
      this.publishChunk(step, { type: 'block-start', index, blockType })
    }
    step[kind] += text
    this.publishChunk(step, { type: deltaType, index: step[indexKey], text })
  }

  // ── tools: routine calls form one activity group; file edits are root calls of their own step ──

  trackTool(active, update) {
    const id = String(update.toolCallId)
    let entry = active.entries.get(id)
    if (entry === undefined) {
      const name = String(update.title ?? update.kind ?? 'tool')
      entry = {
        id,
        name,
        category: classifyActivityTool(update),
        args: update.rawInput ?? {},
        state: 'queued',
        result: undefined,
        callSeq: undefined,
        settled: false,
      }
      active.entries.set(id, entry)
      active.queue.push(entry)
    } else if (entry.state === 'queued' && update.rawInput !== undefined) {
      entry.args = update.rawInput
    }
    return entry
  }

  failEntry(entry, message) {
    if (entry.result === undefined) entry.result = { text: message, isError: true, diffs: [] }
  }

  /** Start queued tools in order while the lane allows it. */
  pump(active) {
    while (active.queue.length > 0) {
      const head = active.queue[0]
      if (active.edit !== undefined) break
      if (head.category === 'edit') {
        if (active.group !== undefined) {
          if (active.group.pending > 0) break
          this.finishGroup(active)
        }
        active.queue.shift()
        this.startEdit(active, head)
        if (head.result !== undefined) this.settleEdit(active, head)
      } else {
        active.queue.shift()
        if (active.group === undefined) this.startGroup(active)
        this.startChild(active, head)
        if (head.result !== undefined) this.settleChild(active, head)
      }
    }
    const quiet = active.queue.length === 0 && active.edit === undefined
      && (active.group === undefined || active.group.pending === 0)
    if (quiet && active.deferred.length > 0) {
      if (active.group !== undefined) this.finishGroup(active)
      else this.replayDeferred(active)
    }
  }

  startGroup(active) {
    const step = this.ensureStep(active)
    const group = {
      ...createActivityState(active.turn, step.step),
      pending: 0,
      children: new Map(),
      callSeq: undefined,
    }
    this.commitAssistant(step, false, [{ id: group.callId, name: GROK_ACTIVITY_TOOL, arguments: '{}' }])
    group.callSeq = this.session.append('tool/call', {
      turn: step.turn,
      step: step.step,
      callId: ToolCallId(group.callId),
      name: GROK_ACTIVITY_TOOL,
      arguments: '{}',
    }).seq
    group.opened = true
    active.group = group
  }

  startChild(active, entry) {
    const group = active.group
    entry.state = 'running'
    group.counts[entry.category] += 1
    group.pending += 1
    group.children.set(entry.id, entry)
    this.session.append('tool/ptc-dispatch-start', {
      rootCallId: ToolCallId(group.callId),
      parentCallId: ToolCallId(group.callId),
      subCallId: ToolCallId(entry.id),
      name: entry.name,
      arguments: entry.args,
    })
  }

  settleChild(active, entry) {
    const group = active.group
    if (entry.settled || group === undefined) return
    entry.settled = true
    entry.state = 'done'
    group.pending -= 1
    const result = entry.result ?? { text: '', isError: false, diffs: [] }
    if (result.isError) group.failed += 1
    this.session.append('tool/ptc-dispatch', {
      rootCallId: ToolCallId(group.callId),
      parentCallId: ToolCallId(group.callId),
      subCallId: ToolCallId(entry.id),
      name: entry.name,
      arguments: entry.args,
      isError: result.isError,
      content: result.text.length === 0 ? [] : [{ type: 'text', text: result.text }],
    })
  }

  finishGroup(active) {
    const group = active.group
    if (group === undefined) return
    for (const entry of group.children.values()) {
      if (entry.settled) continue
      this.failEntry(entry, 'Grok ended the turn without a terminal tool update')
      this.settleChild(active, entry)
    }
    const meta = activityMeta(group)
    group.closed = true
    const step = active.step
    this.session.append('tool/result', {
      turn: step.turn,
      step: step.step,
      message: createToolResultMessage({
        callId: ToolCallId(group.callId),
        content: [{ type: 'text', text: activityFallback(meta) }],
        isError: meta.failed > 0,
      }),
      meta: { grokActivity: meta },
    }, { surfaceOp: 'append', sourceEventSeqs: [group.callSeq] })
    active.group = undefined
    this.endStep(active)
  }

  startEdit(active, entry) {
    const step = this.ensureStep(active)
    const args = JSON.stringify(entry.args)
    this.commitAssistant(step, false, [{ id: entry.id, name: entry.name, arguments: args }])
    entry.callSeq = this.session.append('tool/call', {
      turn: step.turn,
      step: step.step,
      callId: ToolCallId(entry.id),
      name: entry.name,
      arguments: args,
    }).seq
    entry.state = 'running'
    active.edit = entry
  }

  settleEdit(active, entry) {
    if (entry.settled) return
    entry.settled = true
    entry.state = 'done'
    const result = entry.result ?? { text: '', isError: false, diffs: [] }
    const step = active.step
    this.session.append('tool/result', {
      turn: step.turn,
      step: step.step,
      message: createToolResultMessage({
        callId: ToolCallId(entry.id),
        content: result.text.length === 0 ? [] : [{ type: 'text', text: result.text }],
        isError: result.isError,
      }),
      ...(result.diffs.length === 0 ? {} : { meta: { diffs: result.diffs } }),
    }, { surfaceOp: 'append', sourceEventSeqs: [entry.callSeq] })
    active.edit = undefined
    this.endStep(active)
  }

  /** Settle everything still open so `turn/end` is valid: no open step, no unresolved tool. */
  finishTurn(active, interrupted, message = 'Grok ended the turn without a terminal tool update') {
    for (let guard = 0; guard < 10_000; guard += 1) {
      if (active.edit !== undefined) {
        this.failEntry(active.edit, message)
        this.settleEdit(active, active.edit)
        this.pump(active)
        continue
      }
      if (active.group !== undefined) {
        if (active.queue.length === 0) {
          this.finishGroup(active)
          continue
        }
        for (const entry of active.group.children.values()) {
          if (entry.settled) continue
          this.failEntry(entry, message)
          this.settleChild(active, entry)
        }
        this.pump(active)
        continue
      }
      if (active.queue.length > 0) {
        for (const entry of active.queue) this.failEntry(entry, message)
        this.pump(active)
        continue
      }
      if (active.step !== undefined) {
        this.endStep(active, interrupted)
        continue
      }
      if (active.deferred.length > 0) {
        this.replayDeferred(active)
        continue
      }
      return
    }
    throw new Error('could not settle the Grok turn')
  }

  handleUpdate(params) {
    if (params.sessionId !== this.remoteSessionId) return Promise.resolve()
    const update = params.update
    if (update?.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      this.availableCommands = update.availableCommands
      registerGrokCommands(this, update.availableCommands)
      this.ctx.commands?.notifyChange?.()
    }
    if (update?.sessionUpdate === 'session_info_update') this.sessionInfo = update
    if (update?.sessionUpdate === 'model_changed' && typeof update.currentModelId === 'string') {
      this.grokModel = update.currentModelId
    }
    const active = this.active
    if (active === undefined) return Promise.resolve()
    try {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        this.appendText(active, 'text', update.content.text)
      } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
        this.appendText(active, 'reasoning', update.content.text)
      } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        const entry = this.trackTool(active, update)
        if (update.sessionUpdate === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed')) {
          const rendered = renderToolOutput(update)
          entry.result = { text: rendered.text, isError: update.status === 'failed', diffs: rendered.diffs }
          if (entry.state === 'running') {
            if (active.edit === entry) this.settleEdit(active, entry)
            else this.settleChild(active, entry)
          }
        }
        this.pump(active)
      } else if (update.sessionUpdate === 'plan') {
        this.session.append('todo/write', { todos: planTodos(update) })
      }
    } catch (error) {
      this.hostCtx.logger?.warn?.(`dsh-grok-acp: dropped ACP update ${String(update?.sessionUpdate)}: ${errorMessage(error)}`)
    }
    return Promise.resolve()
  }

  handleExt(method, params) {
    if (method.includes('models') && typeof params?.currentModelId === 'string') {
      this.grokModel = params.currentModelId
    }
  }
}

/** Per-turn bookkeeping: the open step, the tool lane, queued tools and held-back text. */
export function createTurnState(turn) {
  return {
    turn,
    nextStep: 1,
    step: undefined,
    queue: [],
    entries: new Map(),
    group: undefined,
    edit: undefined,
    deferred: [],
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Settle with the promise, or reject once `signal` aborted and Grok did not answer within
 * `graceMs`. `session/cancel` is sent separately; this only stops the turn from hanging when
 * the child ignores it.
 */
export function abortable(promise, signal, graceMs) {
  promise.catch(() => {})
  return new Promise((resolve, reject) => {
    let timer
    const onAbort = () => {
      timer = setTimeout(() => reject(signal.reason ?? new Error('aborted')), graceMs)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    })
  })
}

/** The closed cancel-cause vocabulary `turn/end` records; anything unknown counts as the user. */
function abortCause(signal) {
  const kind = signal?.aborted ? signal.reason?.kind : undefined
  return { kind: kind === 'parent' || kind === 'disposed' ? kind : 'user' }
}

/** Factory half: owns Session preparation, durable storage and Agent publication. */
export class GrokAgentFactory {
  constructor(ctx, config, host) {
    this.ctx = ctx
    this.config = config
    this.host = host
    this.handles = new Set()
    this.projectionsReady = undefined
  }

  /** Register the model-selection projection once; the registry tolerates a same-version duplicate. */
  ensureProjections() {
    this.projectionsReady ??= (async () => {
      const handle = await this.ctx.sessionProjections.register(modelSelectionProjectionDefinition)
      return { modelSelection: handle }
    })().catch((error) => {
      this.projectionsReady = undefined
      throw error
    })
    return this.projectionsReady
  }

  persistence() {
    return this.ctx.get('sessionPersistence')
  }

  async createAgent(ownerCtx, options) {
    const projections = await this.ensureProjections()
    const cwd = options.meta?.cwd
    const opened = await this.host.openSession(String(options.sessionId), cwd)
    let preparation
    let stored
    try {
      const session = this.ctx.sessions.prepare(options.sessionId, {
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.meta === undefined ? {} : { meta: options.meta }),
        ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
      })
      preparation = SessionPreparation.create(session)
      const persistence = this.persistence()
      if (persistence !== undefined) {
        stored = {
          handle: await persistence.create(session.header, {
            inheritedEventCount: session.inheritedEventCount,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
          storedCount: 0,
        }
      }
      return await this.finish(ownerCtx, {
        session,
        stored,
        projections,
        agentOptions: options.agentOptions ?? {},
        setup: options.setup,
        opened,
        source: 'startup',
        parentAgent: options.parentAgent,
      })
    } catch (error) {
      await stored?.handle.close().catch(() => {})
      await this.host.closeSession(String(options.sessionId), opened.remoteSessionId)
      throw error
    } finally {
      preparation?.[Symbol.dispose]()
    }
  }

  async resume(ownerCtx, options) {
    const projections = await this.ensureProjections()
    const persistence = this.persistence()
    if (persistence === undefined) throw new Error('cannot resume: session persistence is not configured')
    const id = options.resumeSessionId
    const handle = await persistence.open(id, 'write', options.signal === undefined ? {} : { signal: options.signal })
    let preparation
    let opened
    try {
      const coldRead = await handle.read(0, undefined, options.signal === undefined ? {} : { signal: options.signal })
      const persisted = coldRead.events
      const closers = interruptedTurnClosers(persisted)
      if (closers.length > 0) await handle.append(closers)
      const session = this.ctx.sessions.prepare(id, {
        seed: [...persisted, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: coldRead.eventState,
      })
      preparation = SessionPreparation.create(session)
      const stored = { handle, storedCount: persisted.length + closers.length }
      opened = await this.host.openSession(String(id), session.header.cwd, this.host.mapping.get(String(id)))
      return await this.finish(ownerCtx, {
        session,
        stored,
        projections,
        agentOptions: options.agentOptions ?? {},
        setup: options.setup,
        opened,
        source: 'resume',
        parentAgent: options.parentAgent,
      })
    } catch (error) {
      await handle.close().catch(() => {})
      if (opened !== undefined) await this.host.closeSession(String(id), opened.remoteSessionId)
      throw error
    } finally {
      preparation?.[Symbol.dispose]()
    }
  }

  async appendUnstoredSuffix(stored, session) {
    if (stored === undefined) return
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
    if (suffix.length > 0) await stored.handle.append(suffix)
    stored.storedCount += suffix.length
  }

  async finish(ownerCtx, input) {
    const { session, stored, projections, agentOptions, setup, opened, source, parentAgent } = input
    const lastTurn = this.ctx.agents.turnBoundaryOf(session).lastTurn
    const agent = new GrokWebAgent(this.ctx, session.id, agentOptions, session, {
      modelSelection: projections.modelSelection.readerFor(session),
    }, lastTurn)
    agent.grokModel = this.host.currentModelId ?? DEFAULT_GROK_MODEL
    this.host.bindAgent(opened.remoteSessionId, agent)
    let detachSession
    let detachAgent
    let disposing
    let unfollowOwner = () => {}
    const localId = String(agent.id)
    const dispose = (ownerTriggered = false) => (disposing ??= (async () => {
      agent.cancel({ kind: 'disposed' })
      // A Grok process that ignores session/cancel must not block unloading forever.
      await Promise.race([agent.whenIdle(), delay(this.config.disposeGraceMs ?? 6_000)])
      await this.host.closeSession(localId, opened.remoteSessionId)
      await agent.scope.dispose().catch(() => {})
      await stored?.handle.close().catch(() => {})
      detachAgent?.()
      detachSession?.()
      this.handles.delete(dispose)
      if (!ownerTriggered) await unfollowOwner()
    })())
    this.handles.add(dispose)
    try {
      unfollowOwner = ownerCtx.effect(
        () => () => disposing === undefined ? dispose(true) : undefined,
        `grok-acp.lifecycle(${agent.id})`,
      )
      await this.appendUnstoredSuffix(stored, session)
      detachSession = agent.ctx.sessions.enter(session)
      agent.ctx.sessions.announce(session)
      const commit = await setup?.(agent.ctx, agent)
      commit?.commit?.()
      const presets = this.ctx.get('agentPresets')
      if (presets !== undefined && presets.composedPreset(agent.ctx) !== GROK_PRESET_ID) {
        await presets.mount(agent.ctx, GROK_PRESET_ID)
      }
      registerGrokCommands(agent, this.host.commands)
      detachAgent = this.ctx.agents.enter(agent, parentAgent)
      await this.ctx.agents.announce(agent, source)
      this.ctx.commands?.notifyChange?.()
      return { agent, dispose: () => dispose() }
    } catch (error) {
      await dispose()
      throw error
    }
  }

  async dispose() {
    await Promise.all([...this.handles].map(dispose => dispose()))
  }
}

function registerGrokCommands(agent, extra = []) {
  const commands = agent.ctx.commands
  if (commands === undefined) return
  for (const command of [...WEB_COMMANDS, ...extra]) {
    if (typeof command?.name !== 'string' || CLIENT_OWNED_COMMANDS.has(command.name) || WITHHELD_COMMANDS.has(command.name)) continue
    if (!/^[a-z][a-z0-9_-]*$/.test(command.name)) continue
    const description = typeof command.description === 'string' && command.description.trim().length > 0
      ? command.description
      : command.name
    const hint = typeof command.input?.hint === 'string' && command.input.hint.trim().length > 0
      ? command.input.hint
      : undefined
    try {
      commands.register({
        name: command.name,
        description,
        ...(hint === undefined ? {} : { input: { hint } }),
        handler: commandHandler(command),
      })
    } catch {
      // A standing grok-build mount may already own the name on a parent layer.
    }
  }
}

export { sessionEvents }
