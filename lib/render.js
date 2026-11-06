/** Project Grok ACP payloads into DSH transcript text. */

export function toAcpPrompt(content, options = {}) {
  const imageEnabled = options.image === true
  const blocks = []
  for (const block of content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      blocks.push(mapImageBlock(block, imageEnabled))
    }
  }
  return blocks
}

/**
 * Replace DSH image blocks that only carry an attachment reference with inline base64 blocks, so
 * `toAcpPrompt` can forward them. `store` is the DSH attachment service (`readImage(ref, signal)`);
 * without it, or when a read fails, the block is left alone and becomes a text placeholder.
 */
export async function inlineImages(content, store, signal) {
  if (typeof store?.readImage !== 'function' || !Array.isArray(content)) return content
  return await Promise.all(content.map(async (block) => {
    if (block?.type !== 'image' || block.data !== undefined || block.attachment === undefined) return block
    try {
      const stored = await store.readImage(block.attachment, signal)
      return {
        ...block,
        data: Buffer.from(stored.data).toString('base64'),
        mimeType: stored.ref?.mediaType ?? block.attachment.mediaType,
      }
    } catch {
      return block
    }
  }))
}

function mapImageBlock(block, imageEnabled) {
  if (imageEnabled) {
    const mapped = inlineAcpImage(block)
    if (mapped !== undefined) return mapped
  }
  const name = imageBlockName(block)
  return { type: 'text', text: name === undefined ? '[image attached]' : `[image attached: ${name}]` }
}

function inlineAcpImage(block) {
  const data = typeof block.data === 'string' && block.data.length > 0 ? block.data : undefined
  const mimeType = typeof block.mimeType === 'string' && block.mimeType.length > 0
    ? block.mimeType
    : typeof block.mediaType === 'string' && block.mediaType.length > 0
      ? block.mediaType
      : undefined
  if (data === undefined || mimeType === undefined) return undefined
  return { type: 'image', data, mimeType }
}

function imageBlockName(block) {
  if (typeof block.name === 'string' && block.name.length > 0) return block.name
  if (typeof block.attachment?.name === 'string' && block.attachment.name.length > 0) return block.attachment.name
  return undefined
}

export function renderRawOutput(output) {
  if (output === undefined || output === null) return ''
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return '[unserializable ACP output]'
  }
}

export function renderToolOutput(update) {
  const parts = []
  const diffs = []
  for (const item of update.content ?? []) {
    if (item.type === 'content' && item.content?.type === 'text') parts.push(item.content.text)
    if (item.type === 'terminal' && typeof item.terminalId === 'string') {
      parts.push(`[terminal ${item.terminalId}]`)
    }
    if (item.type !== 'diff') continue
    const oldText = item.oldText ?? null
    diffs.push({ path: item.path, oldText, newText: item.newText })
    parts.push([
      `\`\`\`diff\n--- ${item.path}\n+++ ${item.path}`,
      ...(oldText === null ? [] : oldText.split('\n').map(line => `-${line}`)),
      ...String(item.newText ?? '').split('\n').map(line => `+${line}`),
      '```',
    ].join('\n'))
  }
  if (parts.length === 0) {
    const raw = renderRawOutput(update.rawOutput)
    if (raw.length > 0) parts.push(raw)
  }
  return { text: parts.join('\n\n'), diffs }
}

/** Convert an ACP whole-plan update into DSH's durable todo snapshot. */
export function planTodos(update) {
  const entries = update.entries ?? update.plan?.entries ?? []
  if (!Array.isArray(entries)) return []
  const todos = []
  const seen = new Set()
  for (const entry of entries) {
    const rawContent = entry?.content ?? entry?.title
    if (typeof rawContent !== 'string') continue
    const content = rawContent.trim()
    if (content.length === 0 || seen.has(content)) continue
    seen.add(content)
    const status = entry.status === 'completed' || entry.status === 'in_progress'
      ? entry.status
      : 'pending'
    todos.push({ content, status })
  }
  return todos
}

export function renderBilling(response) {
  const config = response?.config ?? response?.result?.config
  const body = config === undefined || config === null ? response : { ...response, config }
  if (body?.config === undefined || body.config === null) {
    if (typeof response === 'string') return response
    const raw = renderRawOutput(response)
    return raw.length > 0 ? raw : 'Grok Build returned no usage information.'
  }
  const lines = [`Plan: ${body.subscription_tier ?? response?.subscription_tier ?? 'unknown'}`]
  if (typeof body.config.creditUsagePercent === 'number') {
    lines.push(`Credit usage: ${body.config.creditUsagePercent}%`)
  }
  const period = body.config.currentPeriod
  if (typeof period?.start === 'string' && typeof period?.end === 'string') {
    lines.push(`Current period: ${formatDate(period.start)} – ${formatDate(period.end)}`)
  }
  if (body.config.includedUsed !== undefined) lines.push(`Included usage: ${renderScalar(body.config.includedUsed)}`)
  if (body.config.totalUsed !== undefined) lines.push(`Total usage: ${renderScalar(body.config.totalUsed)}`)
  if (body.config.onDemandUsed !== undefined) lines.push(`On-demand usage: ${renderScalar(body.config.onDemandUsed)}`)
  if (body.config.prepaidBalance !== undefined) lines.push(`Prepaid balance: ${renderScalar(body.config.prepaidBalance)}`)
  return lines.join('\n')
}

export function renderContext(result) {
  const context = result?.context ?? result
  if (context === undefined || context === null || typeof context !== 'object') {
    return 'Grok Build returned no context information.'
  }
  const lines = [
    `Context: ${formatInteger(context.used)} / ${formatInteger(context.total)} tokens (${context.usagePct ?? 0}%)`,
    `Free: ${formatInteger(context.freeTokens)} tokens`,
    `Messages: ${formatInteger(context.messageCount)}, ${formatInteger(context.messageTokens)} tokens`,
    `Tool definitions: ${formatInteger(context.toolDefinitionsCount)}, ${formatInteger(context.toolDefinitionsTokens)} tokens`,
  ]
  for (const category of context.usageCategories ?? []) {
    lines.push(`${category.label}: ${formatInteger(category.tokens)} tokens${category.detail ? ` (${category.detail})` : ''}`)
  }
  return lines.join('\n')
}

export function renderSessionInfo(result) {
  if (result === undefined || result === null) return 'Grok Build returned no session information.'
  const context = result.context
  return [
    `Model: ${result.modelDisplayName ?? result.model ?? 'unknown'}`,
    `Session: ${result.sessionId ?? 'unknown'}`,
    `Working directory: ${result.cwd ?? 'unknown'}`,
    `Turns: ${formatInteger(result.turnIndex ?? result.turns)}`,
    context
      ? `Context: ${formatInteger(context.used)} / ${formatInteger(context.total)} tokens (${context.usagePct ?? 0}%)`
      : 'Context: unknown',
  ].join('\n')
}

export function renderScalar(value) {
  if (typeof value === 'number' || typeof value === 'string') return String(value)
  if (typeof value?.val === 'number' || typeof value?.val === 'string') return String(value.val)
  return renderRawOutput(value)
}

export function formatInteger(value) {
  return typeof value === 'number' ? Math.round(value).toLocaleString('en-US') : 'unknown'
}

export function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-GB', { hour12: false })
}

export function permissionOutcome(dshOutcome, options) {
  const list = Array.isArray(options) ? options : []
  if (dshOutcome === 'allowed-once') {
    const option = list.find(candidate => candidate.kind === 'allow_once')
      ?? list.find(candidate => candidate.kind === 'allow_always')
    return option === undefined
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: option.optionId } }
  }
  if (dshOutcome === 'rejected') {
    const option = list.find(candidate => candidate.kind === 'reject_once')
      ?? list.find(candidate => candidate.kind === 'reject_always')
    return option === undefined
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: option.optionId } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

/**
 * Plain-text transcript of the stored conversation, newest turns kept within `limitChars`.
 * Used to give a fresh Grok session the context it lost. Events at or after `beforeSeq` (the
 * turn in progress) are left out.
 */
export function transcriptForReplay(events, beforeSeq, limitChars = 20_000) {
  const lines = []
  for (const event of events) {
    if (event.seq >= beforeSeq) break
    let role
    let content
    if (event.type === 'user/message') {
      role = 'User'
      content = event.data?.content
    } else if (event.type === 'assistant/message') {
      role = 'Assistant'
      content = event.data?.message?.content
    } else continue
    const text = (content ?? [])
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text.length > 0) lines.push(`${role}: ${text}`)
  }
  const kept = []
  let size = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].length > limitChars ? `${lines[index].slice(0, limitChars)}…` : lines[index]
    if (size + line.length > limitChars && kept.length > 0) break
    kept.unshift(line)
    size += line.length + 1
  }
  return kept.join('\n\n')
}
