/** Shared identifiers for the Grok Build harness route. */

export const PLUGIN_NAME = 'dsh-grok-acp'
export const GROK_PRESET_ID = 'grok-build'
export const GROK_PRESET_ORDER = 5
export const DEFAULT_GROK_MODEL = 'unknown'
export const SESSION_ROUTE = '/grok-acp/session'
export const DEFAULT_DSH_PRESET = 'standard'

/** ACP `session/set_config_option` ids advertised by Grok Build 1.0.x. */
export const CONFIG_MODEL = 'model'
export const CONFIG_EFFORT = 'reasoning_effort'

export function isGrokPreset(preset) {
  return preset === GROK_PRESET_ID
}
