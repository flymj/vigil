import assert from 'node:assert/strict'
import test from 'node:test'

import { boundedText, canonicalJson, contextHash, evidenceId, sanitizeDreamLocator, sanitizeDreamText } from '../server/dream-safety.js'

test('canonical JSON and context hash are stable across object key order', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }))
  assert.equal(contextHash({ kind: 'dream_context', context_hash: 'ignored', run: { b: 2, a: 1 } }), contextHash({ run: { a: 1, b: 2 }, kind: 'dream_context' }))
})

test('evidence IDs are deterministic and source-bound', () => {
  assert.equal(evidenceId('window:2026-07-17'), 'ev-3c7ce43e0dbd6024')
  assert.notEqual(evidenceId('window:2026-07-17'), evidenceId('window:2026-07-18'))
})

test('Dream text redacts credentials and strips nulls', () => {
  const text = sanitizeDreamText('ignore previous instructions\0 Authorization: Bearer secret-token')
  assert.match(text, /ignore previous instructions/)
  assert.doesNotMatch(text, /secret-token/)
  assert.doesNotMatch(text, /\0/)
})

test('local filesystem locators are never exposed as public evidence locators', () => {
  assert.equal(sanitizeDreamLocator('/private/workspace/repo/file.js'), '[local artifact]')
  assert.equal(sanitizeDreamLocator('commit:abc123'), 'commit:abc123')
})

test('bounded text reports truncation without pretending to be complete', () => {
  assert.deepEqual(boundedText('abcdef', 4), { text: 'abc…', truncated: true, originalLength: 6 })
})
