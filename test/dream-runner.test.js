import assert from 'node:assert/strict'
import test from 'node:test'

import { createDreamRunner } from '../server/dream-runner.js'
import { createDreamStore } from '../server/dream-store.js'

const horizon = { start: '2026-07-17T00:00:00.000Z', end: '2026-07-18T00:00:00.000Z', timezone: 'Asia/Shanghai' }
const settings = {
  workspace: { directory: '/tmp/vigil-dream-runner-test' },
  dreamSchedule: { leaseSeconds: 900, maxCandidates: 2, maxEvidenceRequests: 2, maxSignalChanges: 1, maxTopicChanges: 1, contextMaxChars: 100_000 },
}

function boundaryWindow(overrides = {}) {
  return {
    id: 'window-midnight',
    rangeStart: horizon.start,
    rangeEnd: horizon.end,
    timezone: horizon.timezone,
    publishTime: '00:00',
    status: 'published',
    report: { analysis: { content: 'No material repository changes.' } },
    repositoryRuns: [],
    ...overrides,
  }
}

function noFinding(context) {
  return {
    kind: 'dream_batch', schema_version: '2.1',
    run: {
      id: context.run.id,
      scope: context.run.scope,
      generated_at: '2026-07-18T00:05:00.000Z',
      horizon: context.run.horizon,
      context_hash: context.context_hash,
      idempotency_key: context.run.idempotency_key,
      known_state: context.run.known_state,
      cursor: { before: context.run.cursor_before, candidate_after: context.run.horizon.end, advance_on_publish: true },
      outcome: 'no_finding', notes: 'No candidate crossed the evidence gate.', candidates: [], suppression_groups: [],
    },
    signal_changes: [],
    topic_decision: { action: 'none', reason: 'No durable topic is justified.' },
    topic_changes: [],
  }
}

function dependencies(store, windows, counters = {}) {
  return {
    store,
    windowStore: { list: async () => windows },
    now: () => new Date('2026-07-18T00:05:00.000Z'),
    scout: async (_settings, context) => {
      counters.scout = (counters.scout || 0) + 1
      return { scout: { kind: 'dream_scout', schema_version: '2.1', context_hash: context.context_hash, candidates: [], evidence_requests: [], blocked_reason: null }, model: 'test', usage: null, raw: '{}' }
    },
    expandEvidence: async ({ scoutContext }) => ({ evidenceCatalog: scoutContext.observations, diagnostics: [] }),
    synthesize: async (_settings, context) => {
      counters.synthesis = (counters.synthesis || 0) + 1
      const batch = noFinding(context)
      return { batch, model: 'test', usage: null, raw: JSON.stringify(batch) }
    },
  }
}

test('complete midnight horizon runs once and atomically accepts no-finding', async () => {
  const store = createDreamStore(settings, { databasePath: ':memory:' })
  const counters = {}
  try {
    const runner = createDreamRunner(dependencies(store, [boundaryWindow()], counters))
    const first = await runner.run(horizon, settings, [])
    assert.equal(first.status, 'accepted')
    assert.equal(first.outcome, 'no_finding')
    assert.equal(store.state(first.scope).cursor, horizon.end)
    const replay = await runner.run(horizon, settings, [])
    assert.equal(replay.id, first.id)
    assert.equal(counters.scout, 1)
    assert.equal(counters.synthesis, 1)
  } finally {
    store.close()
  }
})

test('missing midnight boundary creates blocked audit and leaves cursor pending', async () => {
  const store = createDreamStore(settings, { databasePath: ':memory:' })
  try {
    const runner = createDreamRunner(dependencies(store, [boundaryWindow({ publishTime: '16:00' })]))
    const result = await runner.run(horizon, settings, [])
    assert.equal(result.status, 'blocked')
    assert.equal(store.state(result.scope).cursor, null)
  } finally {
    store.close()
  }
})

test('provider failure is staged and cannot mutate ledger or cursor', async () => {
  const store = createDreamStore(settings, { databasePath: ':memory:' })
  try {
    const deps = dependencies(store, [boundaryWindow()])
    deps.scout = async () => {
      const error = new Error('Provider output failed validation')
      error.rawOutput = '{"unexpected":true}'
      error.providerModel = 'test-model'
      error.providerUsage = { total_tokens: 42 }
      throw error
    }
    const result = await createDreamRunner(deps).run(horizon, settings, [])
    assert.equal(result.status, 'failed')
    assert.equal(result.stage, 'scout')
    assert.match(result.error, /failed validation/)
    const audit = store.getRun(result.id, { includeAudit: true })
    assert.equal(audit.rawOutput, '{"unexpected":true}')
    assert.equal(audit.providerModel, 'test-model')
    assert.deepEqual(store.state(result.scope).versions, { signals: 0, topics: 0, evidence: 0 })
    assert.equal(store.state(result.scope).cursor, null)
  } finally {
    store.close()
  }
})

test('oversized known/context state blocks before synthesis without truncation', async () => {
  const store = createDreamStore(settings, { databasePath: ':memory:' })
  const counters = {}
  try {
    const constrained = { ...settings, dreamSchedule: { ...settings.dreamSchedule, contextMaxChars: 10 } }
    const runner = createDreamRunner(dependencies(store, [boundaryWindow()], counters))
    const result = await runner.run(horizon, constrained, [])
    assert.equal(result.status, 'blocked')
    assert.equal(counters.synthesis || 0, 0)
    assert.equal(store.state(result.scope).cursor, null)
  } finally {
    store.close()
  }
})
