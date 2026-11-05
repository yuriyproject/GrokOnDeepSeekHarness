/** Locate the Grok Build CLI and build the isolated environment it runs in. */

import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

const WINDOWS = process.platform === 'win32'

/** Environment variables Grok Build needs to start; secrets are never forwarded. */
const PASSTHROUGH = WINDOWS
  ? [
    'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  ]
  : ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR']

/** Names that must never reach the child, whatever the config says (compared case-insensitively). */
const FORBIDDEN = new Set(['XAI_API_KEY'])

function lookup(source, name) {
  if (source[name] !== undefined) return source[name]
  if (!WINDOWS) return source[name.toLowerCase()]
  const wanted = name.toUpperCase()
  for (const key of Object.keys(source)) {
    if (key.toUpperCase() === wanted) return source[key]
  }
  return undefined
}

function userHome(env = process.env) {
  return lookup(env, 'HOME') || lookup(env, 'USERPROFILE') || homedir()
}

/** `GROK_COMMAND`, else `~/.grok/bin/grok(.exe)` when installed, else `grok` from PATH. */
export function defaultGrokCommand(env = process.env) {
  if (env.GROK_COMMAND) return env.GROK_COMMAND
  const bundled = join(userHome(env), '.grok', 'bin', WINDOWS ? 'grok.exe' : 'grok')
  return existsSync(bundled) ? bundled : 'grok'
}

/** The Grok state directory: `GROK_HOME` when set, otherwise Grok's own `~/.grok`. */
export function defaultGrokHome(env = process.env) {
  return env.GROK_HOME && env.GROK_HOME.length > 0 ? env.GROK_HOME : undefined
}

/**
 * A neutral working directory for the shared Grok process. The session workspace is passed to
 * every ACP session explicitly, so the process cwd must not be the Grok state directory.
 */
export function grokProcessCwd() {
  return tmpdir()
}

/**
 * Environment overlay for `grok agent stdio`.
 *
 * DSH builds the child environment as "scrubbed parent environment, then this overlay". The scrub
 * removes only credential-shaped names and `DSH_*`, so everything else the parent has would still
 * be inherited. This overlay therefore (a) sets the few variables the CLI needs and (b) adds an
 * explicit `undefined` tombstone for every other parent variable, which DSH treats as "remove".
 * `GROK_HOME` pins auth, sessions and logs; `XAI_API_KEY` is never forwarded in any letter case.
 */
export function grokChildEnv(config = {}, parent = process.env) {
  const env = {}
  for (const key of PASSTHROUGH) {
    const value = lookup(parent, key)
    if (value !== undefined) env[key] = value
  }
  if (!WINDOWS && env.HOME === undefined) env.HOME = userHome(parent)
  const binDirs = []
  if (config.command && (config.command.includes('/') || config.command.includes('\\'))) {
    binDirs.push(dirname(config.command))
  }
  binDirs.push(join(userHome(parent), '.grok', 'bin'))
  env.PATH = [...binDirs, lookup(parent, 'PATH') ?? ''].filter(Boolean).join(delimiter)
  env.TERM = 'dumb'
  env.NO_COLOR = '1'
  if (config.grokHome) env.GROK_HOME = config.grokHome
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (FORBIDDEN.has(key.toUpperCase()) || typeof value !== 'string') continue
    env[key] = value
  }
  for (const key of Object.keys(env)) {
    if (FORBIDDEN.has(key.toUpperCase())) delete env[key]
  }
  const kept = new Set(Object.keys(env).map(key => key.toUpperCase()))
  for (const key of Object.keys(parent)) {
    if (!kept.has(key.toUpperCase())) env[key] = undefined
  }
  return env
}
