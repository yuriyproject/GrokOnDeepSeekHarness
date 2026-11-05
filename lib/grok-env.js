/** Locate the Grok Build CLI and build the isolated environment it runs in. */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

const WINDOWS = process.platform === 'win32'

/** Environment variables Grok Build needs to start; secrets are never forwarded. */
const PASSTHROUGH = WINDOWS
  ? [
    'SYSTEMROOT', 'SystemRoot', 'SYSTEMDRIVE', 'SystemDrive', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy',
  ]
  : ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']

function userHome() {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

/** `~/.grok/bin/grok(.exe)` when installed, else `grok` from PATH. */
export function defaultGrokCommand(env = process.env) {
  if (env.GROK_COMMAND) return env.GROK_COMMAND
  const bundled = join(userHome(), '.grok', 'bin', WINDOWS ? 'grok.exe' : 'grok')
  return existsSync(bundled) ? bundled : 'grok'
}

/** The Grok state directory: `GROK_HOME` when set, otherwise Grok's own `~/.grok`. */
export function defaultGrokHome(env = process.env) {
  return env.GROK_HOME && env.GROK_HOME.length > 0 ? env.GROK_HOME : undefined
}

/**
 * Minimal child environment for `grok agent stdio`.
 *
 * Only the variables the CLI needs to start are passed through. `GROK_HOME`
 * pins auth, sessions and logs to the configured profile directory;
 * `XAI_API_KEY` is deliberately never forwarded so the bridge uses the CLI's
 * OAuth login only.
 */
export function grokChildEnv(config = {}, parent = process.env) {
  const env = {}
  for (const key of PASSTHROUGH) {
    if (parent[key] !== undefined) env[key] = parent[key]
  }
  if (!WINDOWS && env.HOME === undefined) env.HOME = userHome()
  const binDirs = []
  if (config.command && (config.command.includes('/') || config.command.includes('\\'))) {
    binDirs.push(dirname(config.command))
  }
  binDirs.push(join(userHome(), '.grok', 'bin'))
  env.PATH = [...binDirs, parent.PATH ?? parent.Path ?? ''].filter(Boolean).join(delimiter)
  env.TERM = 'dumb'
  env.NO_COLOR = '1'
  if (config.grokHome) env.GROK_HOME = config.grokHome
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (key === 'XAI_API_KEY') continue
    if (typeof value === 'string') env[key] = value
  }
  delete env.XAI_API_KEY
  return env
}
