import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { defaultGrokCommand, defaultGrokHome, grokChildEnv } from '../lib/grok-env.js'

describe('grokChildEnv', () => {
  const parent = {
    PATH: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin',
    SYSTEMROOT: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\tester',
    HOME: '/home/tester',
    XAI_API_KEY: 'xai-secret',
    OPENAI_API_KEY: 'sk-secret',
    DSH_TOKEN: 'token',
    GROK_HOME: 'C:\\somewhere-else',
  }

  it('never forwards XAI_API_KEY or unrelated secrets', () => {
    const env = grokChildEnv({ env: { XAI_API_KEY: 'from-config', EXTRA: '1' } }, parent)
    assert.equal(env.XAI_API_KEY, undefined)
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.DSH_TOKEN, undefined)
    assert.equal(env.EXTRA, '1')
  })

  it('pins state to the configured GROK_HOME and ignores the parent value', () => {
    const env = grokChildEnv({ grokHome: 'C:\\DSProjects\\grok\\home-ultra' }, parent)
    assert.equal(env.GROK_HOME, 'C:\\DSProjects\\grok\\home-ultra')
    assert.equal(grokChildEnv({}, parent).GROK_HOME, undefined)
  })

  it('puts the directory of an absolute command first on PATH', () => {
    const command = process.platform === 'win32' ? 'C:\\Users\\tester\\.grok\\bin\\grok.exe' : '/opt/grok/bin/grok'
    const env = grokChildEnv({ command }, parent)
    assert.ok(env.PATH.startsWith(process.platform === 'win32' ? 'C:\\Users\\tester\\.grok\\bin' : '/opt/grok/bin'))
  })
})

describe('grokChildEnv overlay against the DSH merge', () => {
  // DSH: child = scrubbed parent, then overlay; an explicit undefined removes an inherited entry.
  function dshMerge(overlay, scrubbedParent) {
    const merged = { ...scrubbedParent }
    for (const [key, value] of Object.entries(overlay)) {
      if (value === undefined) delete merged[key]
      else merged[key] = value
    }
    return merged
  }

  it('removes every inherited variable the bridge does not name, in any letter case', () => {
    const parent = { PATH: '/usr/bin', HOME: '/home/t', NODE_OPTIONS: '--require x', SSLKEYLOGFILE: '/tmp/k', xai_api_key: 'secret', HTTPS_PROXY: 'http://u:p@proxy' }
    const overlay = grokChildEnv({ env: { Xai_Api_Key: 'again' } }, parent)
    const child = dshMerge(overlay, parent)
    assert.equal(child.NODE_OPTIONS, undefined)
    assert.equal(child.SSLKEYLOGFILE, undefined)
    assert.equal(Object.keys(child).some(key => key.toUpperCase() === 'XAI_API_KEY'), false)
    assert.ok(child.PATH)
  })
})

describe('Grok defaults', () => {
  it('honours GROK_COMMAND and GROK_HOME', () => {
    assert.equal(defaultGrokCommand({ GROK_COMMAND: 'C:\\x\\grok.exe' }), 'C:\\x\\grok.exe')
    assert.equal(defaultGrokHome({ GROK_HOME: 'D:\\g' }), 'D:\\g')
    assert.equal(defaultGrokHome({}), undefined)
  })
})
