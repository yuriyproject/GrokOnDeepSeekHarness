import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createReplacementTracker } from '../src/client/replacement-filter.ts'

function tracker() {
  const timers = []
  const instance = createReplacementTracker({
    timeoutMs: 10_000,
    schedule(fn, ms) {
      const timer = { fn, ms, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })
  return { instance, timers }
}

describe('harness switch replacement tracker', () => {
  it('suppresses only the removal that belongs to the active switch generation', () => {
    const { instance } = tracker()
    const first = instance.begin('s1')
    const second = instance.begin('s1')
    assert.notEqual(first, second)
    assert.equal(instance.noteRemoval('s1', () => { throw new Error('should not replay a superseded switch') }), true)
    assert.equal(instance.shouldSuppressRemoval('s1'), true)
    assert.equal(instance.shouldSuppressRemoval('s2'), false)
    const replayed = []
    instance.noteAdded('s1', false)
    assert.equal(instance.shouldSuppressRemoval('s1'), true)
    instance.noteAdded('s1', true)
    assert.equal(instance.shouldSuppressRemoval('s1'), false)
    instance.noteRemoval('s1', () => replayed.push('real'))
    assert.deepEqual(replayed, [])
  })

  it('replays a suppressed removal if the replacement agent never becomes available', () => {
    const { instance, timers } = tracker()
    instance.begin('s1')
    const replayed = []
    assert.equal(instance.noteRemoval('s1', () => replayed.push('s1')), true)
    assert.equal(timers.length, 1)
    assert.equal(timers[0].ms, 10_000)
    timers[0].fn()
    assert.deepEqual(replayed, ['s1'])
    assert.equal(instance.shouldSuppressRemoval('s1'), false)
  })

  it('does not replay a removal after the matching agentAvailable add', () => {
    const { instance, timers } = tracker()
    instance.begin('s1')
    const replayed = []
    instance.noteRemoval('s1', () => replayed.push('s1'))
    instance.noteAdded('s1', true)
    assert.equal(timers[0].cancelled, true)
    timers[0].fn()
    assert.deepEqual(replayed, [])
  })
})
