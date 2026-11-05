#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshCommand = process.env.DSH_COMMAND || 'dsh'
const profile = process.env.DSH_PROFILE || 'web'
const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const supportedDshVersion = '0.2.2-rc.1'

function grokCommand() {
  if (process.env.GROK_COMMAND) return process.env.GROK_COMMAND
  const bundled = join(process.env.USERPROFILE || process.env.HOME || homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok')
  return existsSync(bundled) ? bundled : 'grok'
}

function printHelp() {
  process.stdout.write(`dsh-grok: helper for the DSH / Grok Build bridge (DeepSeek Harness ${supportedDshVersion})

Usage:
  dsh-grok setup      install this package into the DSH profile "${profile}" (DSH_PROFILE overrides)
  dsh-grok doctor     check the installation
  dsh-grok web        start "dsh ${profile}" with the Grok environment

Environment: DSH_COMMAND, DSH_PROFILE, DSH_HOME, GROK_COMMAND, GROK_HOME.
The "desktop" profile is managed by the app: quit DeepSeek Harness before using it.
`)
}

/** Run a command without a shell; arguments stay a separate array so paths with spaces survive. */
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.trim()
}

function inherit(command, args) {
  const child = spawn(command, args, { stdio: 'inherit', cwd: process.cwd(), env: process.env, shell: false })
  child.once('error', (error) => {
    process.stderr.write(`dsh-grok: cannot start ${command}: ${error.message}\n`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
}

function setup() {
  const version = capture(dshCommand, ['--version'])
  if (version !== supportedDshVersion) {
    process.stderr.write(`dsh-grok: warning: built for dsh ${supportedDshVersion}; found ${version}\n`)
  }
  if (!existsSync(join(packageRoot, 'lib', 'client.js'))) {
    throw new Error('lib/client.js is missing; run "npm ci --legacy-peer-deps && npm run check" in the source checkout first')
  }
  process.stdout.write(`Installing ${packageRoot} into dsh profile "${profile}" (dsh ${version}).\n`)
  process.stdout.write(`${capture(dshCommand, ['plugin', '--profile', profile, 'add', packageRoot])}\n`)
  process.stdout.write(`Done. Start it with: dsh-grok web\n`)
}

function doctor() {
  const dshVersion = capture(dshCommand, ['--version'])
  const command = grokCommand()
  let grokVersion = 'not found'
  try { grokVersion = capture(command, ['--version']) } catch (error) { grokVersion = `not found (${error.message})` }
  const manifest = join(dshHome, 'profiles', profile, 'package.json')
  let installed = false
  try {
    const bundles = JSON.parse(readFileSync(manifest, 'utf8')).dsh?.profile?.bundles ?? []
    installed = bundles.includes('dsh-grok-acp')
  } catch {
    // The profile does not exist yet.
  }
  const lines = [
    `dsh: ${dshVersion}${dshVersion === supportedDshVersion ? '' : ` (built for ${supportedDshVersion})`}`,
    `grok: ${grokVersion} [${command}]`,
    `GROK_HOME: ${process.env.GROK_HOME || '(Grok default)'}`,
    `DSH home: ${dshHome}`,
    `profile "${profile}": ${installed ? 'dsh-grok-acp installed' : 'dsh-grok-acp not installed'}`,
    `client bundle: ${existsSync(join(packageRoot, 'lib', 'client.js')) ? 'built' : 'missing'}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  if (!installed) throw new Error('not installed; run dsh-grok setup')
}

const [action, ...args] = process.argv.slice(2)
try {
  if (action === 'setup') setup()
  else if (action === 'doctor') doctor()
  else if (action === 'web') inherit(dshCommand, [profile, ...args])
  else if (action === undefined || action === '--help' || action === '-h' || action === 'help') printHelp()
  else {
    printHelp()
    process.exitCode = 2
  }
} catch (error) {
  process.stderr.write(`dsh-grok: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
