/** Grok Build Web commands mounted only beneath Grok-backed agents. */

export const name = 'grok-build-harness-marker'
export const inject = ['commands']

/** Client contributions that must never appear as host commands, or `/` dies. */
export const CLIENT_OWNED_COMMANDS = new Set(['model', 'models'])

/** Commands Grok advertises that the bridge refuses to expose (see the note below). */
export const WITHHELD_COMMANDS = new Set(['always-approve'])

/**
 * `/always-approve` is deliberately absent. Approval is owned by DSH (ask, or the session's
 * Full access mode). Forwarding the text would flip Grok's own auto-approve while the user believes
 * a local switch changed.
 */
export const WEB_COMMANDS = [
  { name: 'compact', description: 'Compact the Grok session context', input: { hint: '[what to keep]' } },
  { name: 'context', description: 'Show Grok context usage' },
  { name: 'session-info', description: 'Show Grok session information' },
  { name: 'deep-research', description: 'Start a Grok deep-research workflow', input: { hint: '<question>' } },
  { name: 'workflow', description: 'Start or manage a Grok workflow', input: { hint: '<name or action>' } },
  { name: 'goal', description: 'Set or manage a Grok autonomous goal', input: { hint: '<goal or action>' } },
  { name: 'usage', description: 'Show Grok plan and quota usage' },
  { name: 'cost', description: 'Show Grok plan and quota usage (alias of /usage)' },
  { name: 'btw', description: 'Ask Grok a side question without touching the main conversation', input: { hint: '<question>' } },
  { name: 'status', description: 'Show Grok session information (alias of /session-info)' },
  { name: 'info', description: 'Show Grok session information (alias of /session-info)' },
  { name: 'effort', description: 'Set Grok reasoning effort', input: { hint: '[low|medium|high|xhigh]' } },
  { name: 'grok-model', description: 'Show or set the Grok Build model', input: { hint: '[model id]' } },
]

export function commandHandler(command) {
  return (invocation) => {
    const agent = invocation.agent
    if (typeof agent?.runWebCommand !== 'function') {
      return { kind: 'error', text: `/${command.name} is only available in a Grok Build session` }
    }
    return agent.runWebCommand(command.name, invocation.rawInput ?? '')
  }
}

export function apply(ctx) {
  for (const command of WEB_COMMANDS) {
    if (CLIENT_OWNED_COMMANDS.has(command.name)) continue
    ctx.commands.register({ ...command, handler: commandHandler(command) })
  }
}
