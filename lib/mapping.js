/** Durable map from DSH session ids to Grok ACP session ids. */

import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 2_000

function parseFile(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed?.version !== 1 || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
    throw new Error('expected { version: 1, sessions: object }')
  }
  const sessions = new Map()
  for (const [local, remote] of Object.entries(parsed.sessions)) {
    if (typeof remote === 'string') sessions.set(local, remote)
  }
  return sessions
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export class SessionMapping {
  /**
   * @param {string} path Mapping file.
   * @param {{ warn?: (message: string) => void }} [logger] Receives a notice when a corrupt file is set aside.
   */
  constructor(path, logger = {}) {
    this.path = resolve(path)
    this.sessions = new Map()
    try {
      this.sessions = parseFile(this.path)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      // A damaged map must not stop DSH from loading the plugin: keep the file for inspection and
      // start empty. Sessions with no entry simply start a new Grok session.
      const aside = `${this.path}.corrupt-${Date.now()}`
      try {
        renameSync(this.path, aside)
      } catch {
        // Nothing more to do; the next flush overwrites the file.
      }
      logger.warn?.(`dsh-grok-acp: session map ${this.path} is unreadable (${error.message}); moved to ${aside}`)
    }
  }

  get(localId) {
    return this.sessions.get(localId)
  }

  set(localId, remoteId) {
    const previous = this.sessions.get(localId)
    this.sessions.set(localId, remoteId)
    try {
      this.flush(localId, remoteId)
    } catch (error) {
      if (previous === undefined) this.sessions.delete(localId)
      else this.sessions.set(localId, previous)
      throw error
    }
  }

  /**
   * Merge-on-write under an exclusive lock: re-read the file so entries written by another DSH
   * process on the same home survive, apply this process's entry, then replace atomically.
   */
  flush(localId, remoteId) {
    mkdirSync(dirname(this.path), { recursive: true })
    const release = this.lock()
    try {
      let merged = this.sessions
      try {
        merged = parseFile(this.path)
        for (const [local, remote] of this.sessions) {
          if (!merged.has(local)) merged.set(local, remote)
        }
      } catch {
        // Missing or unreadable file: write this process's view.
      }
      if (localId !== undefined) merged.set(localId, remoteId)
      this.sessions = merged
      const temp = `${this.path}.${process.pid}.tmp`
      const sessions = Object.fromEntries([...merged].sort(([a], [b]) => a.localeCompare(b)))
      writeFileSync(temp, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, { mode: 0o600 })
      renameSync(temp, this.path)
    } finally {
      release()
    }
  }

  lock() {
    const lockPath = `${this.path}.lock`
    const deadline = Date.now() + LOCK_WAIT_MS
    while (true) {
      try {
        const fd = openSync(lockPath, 'wx')
        closeSync(fd)
        return () => {
          try { unlinkSync(lockPath) } catch { /* already gone */ }
        }
      } catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath)
        } catch {
          // The holder released it between the checks.
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockPath}`)
        sleepSync(20)
      }
    }
  }
}
