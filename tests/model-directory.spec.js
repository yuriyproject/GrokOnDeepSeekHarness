import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileModelCurrent, requestErrorAlert } from '../lib/model-seat.js'

const oldSelection = { provider: 'deepseek', model: 'v3' }
const newSelection = { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' }

describe('reconcileModelCurrent', () => {
  it('keeps a just-selected model until the projection names the same route', () => {
    assert.deepEqual(reconcileModelCurrent(newSelection, oldSelection), newSelection)
    assert.deepEqual(reconcileModelCurrent(newSelection, newSelection), newSelection)
    assert.deepEqual(reconcileModelCurrent(null, oldSelection), oldSelection)
  })
})

describe('requestErrorAlert', () => {
  it('builds a title/role=alert payload from a failed request', () => {
    assert.deepEqual(requestErrorAlert(new Error('HTTP 400')), {
      title: 'HTTP 400',
      role: 'alert',
    })
    assert.deepEqual(requestErrorAlert('nope'), {
      title: 'nope',
      role: 'alert',
    })
  })
})
