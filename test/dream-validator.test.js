import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { contextHash } from '../server/dream-safety.js'
import { DreamValidationError, assertValidDreamBatch, parseStrictDreamJson, validateDreamBatch, validateDreamScout } from '../server/dream-validator.js'

const examples = path.resolve('skills/vigil-dream/examples')
const fixture = (name) => JSON.parse(readFileSync(path.join(examples, name), 'utf8'))

test('JavaScript validator accepts the same finding, no-finding, and blocked fixtures as Python oracle', () => {
  const context = fixture('context.json')
  for (const name of ['finding.json', 'no-finding.json', 'blocked.json']) {
    assert.deepEqual(validateDreamBatch(fixture(name), context), [], name)
  }
})

test('strict parser rejects Markdown fences and multiple documents', () => {
  assert.throws(() => parseStrictDreamJson('```json\n{}\n```'), DreamValidationError)
  assert.throws(() => parseStrictDreamJson('{}\n{}'), /not valid JSON/)
  assert.deepEqual(parseStrictDreamJson('{"kind":"ok"}'), { kind: 'ok' })
})

test('schema, semantic, and Host context failures remain distinct diagnostics', () => {
  const context = fixture('context.json')
  const batch = fixture('finding.json')
  batch.unexpected = true
  batch.run.cursor.candidate_after = '2099-01-01T00:00:00Z'
  batch.signal_changes[0].revision.evidence_ids = ['ev-0000000000000000']
  const errors = validateDreamBatch(batch, context)
  assert.ok(errors.some((error) => error.includes('additional properties')))
  assert.ok(errors.some((error) => error.includes('Host horizon end')))
  assert.ok(errors.some((error) => error.includes('not issued by Host')))
})

test('due forecasts and unpaired supersession cannot pass runtime validation', () => {
  const context = fixture('context.json')
  context.known_state.forecasts = [{ id: 'fc-12121212-1212-4121-8121-121212121212', signal_id: 'sig-known', claim: 'due', due_at: context.run.horizon.end, status: 'open' }]
  context.context_hash = contextHash(context)
  const batch = fixture('no-finding.json')
  batch.run.context_hash = context.context_hash
  assert.ok(validateDreamBatch(batch, context).some((error) => error.includes('must be evaluated')))

  const superseding = fixture('finding.json')
  superseding.signal_changes[0].revision.supersedes = 'sig-13131313-1313-4131-8131-131313131313'
  assert.ok(validateDreamBatch(superseding, fixture('context.json')).some((error) => error.includes('paired old')))
})

test('scout may use only Host candidates, known IDs, and allowed source refs', () => {
  const context = {
    context_hash: 'a'.repeat(64),
    candidate_ids: ['cand-11111111-1111-4111-8111-111111111111'],
    repository_ids: ['repo'],
    observations: [{ id: 'ev-observed' }],
    known_state: { signals: [{ id: 'sig-known' }], topics: [], forecasts: [] },
    allowed_evidence_requests: [{ repository_id: 'repo', kind: 'code_review', ref: '42' }],
    limits: { max_candidates: 1, max_evidence_requests: 1 },
  }
  const scout = {
    kind: 'dream_scout', schema_version: '2.1', context_hash: context.context_hash,
    candidates: [{ id: context.candidate_ids[0], title: 'Candidate', reason: 'Mechanism changed', repository_ids: ['repo'], source_refs: ['ev-observed'], compared_signal_ids: ['sig-known'], compared_topic_ids: [] }],
    evidence_requests: [{ candidate_id: context.candidate_ids[0], repository_id: 'repo', kind: 'code_review', ref: '42', reason: 'Need direct diff' }],
    blocked_reason: null,
  }
  assert.deepEqual(validateDreamScout(scout, context), [])
  scout.evidence_requests[0].ref = '999'
  assert.ok(validateDreamScout(scout, context).some((error) => error.includes('outside Host manifest')))
})

test('assertValidDreamBatch returns the original object and throws structured errors', () => {
  const batch = fixture('no-finding.json')
  assert.equal(assertValidDreamBatch(batch, fixture('context.json')), batch)
  batch.run.context_hash = '0'.repeat(64)
  assert.throws(() => assertValidDreamBatch(batch, fixture('context.json')), (error) => error instanceof DreamValidationError && error.errors.length > 0)
})
