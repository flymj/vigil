import assert from 'node:assert/strict'
import test from 'node:test'

import { dreamCollectionState, forecastTone, percentScore, runOutcomeLabel } from '../src/dream-view-model.js'

test('Dream collection state distinguishes readiness and terminal outcomes', () => {
  assert.equal(dreamCollectionState({ loading: true }), 'loading')
  assert.equal(dreamCollectionState({ error: 'offline' }), 'error')
  assert.equal(dreamCollectionState({ dream: { enabled: false } }), 'disabled')
  assert.equal(dreamCollectionState({ dream: { enabled: true, ready: false } }), 'unavailable')
  assert.equal(dreamCollectionState({ dream: { enabled: true, ready: true } }), 'never_run')
  assert.equal(dreamCollectionState({ dream: { enabled: true, ready: true, currentRun: { status: 'running' } } }), 'running')
  assert.equal(dreamCollectionState({ total: 2, dream: { enabled: true, ready: true, currentRun: { status: 'running' } } }), 'refreshing')
  assert.equal(dreamCollectionState({ total: 2, dream: { enabled: true, ready: true, lastRun: { status: 'accepted' } } }), 'ready')
  assert.equal(dreamCollectionState({ dream: { enabled: true, ready: true, lastRun: { status: 'blocked' } } }), 'blocked')
  assert.equal(dreamCollectionState({ dream: { enabled: true, ready: true, lastRun: { status: 'failed' } } }), 'failed')
  assert.equal(dreamCollectionState({ dream: { enabled: true, ready: true, lastRun: { status: 'accepted', outcome: 'duplicate_only' } } }), 'no_finding')
})

test('scores are clamped and rounded for dense displays', () => {
  assert.equal(percentScore(0.826), 83)
  assert.equal(percentScore(-1), 0)
  assert.equal(percentScore(2), 100)
  assert.equal(percentScore('unknown'), 0)
})

test('forecast and run labels preserve correction semantics', () => {
  assert.equal(forecastTone({ status: 'confirmed' }), 'confirmed')
  assert.equal(forecastTone({ status: 'refuted' }), 'refuted')
  assert.equal(forecastTone({ status: 'inconclusive' }), 'inconclusive')
  assert.equal(runOutcomeLabel({ outcome: 'duplicate_only' }), '候选已在已知账本')
  assert.equal(runOutcomeLabel({ outcome: 'blocked_incomplete_sources' }), '证据源不完整')
  assert.equal(runOutcomeLabel({ outcome: 'state_updated' }), '已修正已知判断')
})
