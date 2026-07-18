import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDreamStore } from '../server/dream-store.js'

const examples = path.resolve('skills/vigil-dream/examples')

function fixture(name) {
  return JSON.parse(readFileSync(path.join(examples, name), 'utf8'))
}

function settings(directory = '.') {
  return { workspace: { directory } }
}

function claimFor(store, context, now = new Date('2026-07-18T00:01:00Z')) {
  return store.claim({
    id: context.run.id,
    scope: context.run.scope,
    idempotencyKey: context.run.idempotency_key,
    horizon: context.run.horizon,
    leaseSeconds: 900,
  }, now)
}

function prepare(store, context, leaseToken) {
  store.saveStage(context.run.id, leaseToken, 'synthesis', { context, context_hash: context.context_hash }, new Date('2026-07-18T00:02:00Z'))
}

test('finding batch commits Signal, Topic, evidence, forecast, cursor, and audit atomically', () => {
  const store = createDreamStore(settings(), { databasePath: ':memory:' })
  try {
    const context = fixture('context.json')
    const batch = fixture('finding.json')
    const claim = claimFor(store, context)
    assert.equal(claim.claimed, true)
    prepare(store, context, claim.leaseToken)
    const result = store.applyBatch({ id: context.run.id, leaseToken: claim.leaseToken, context, batch }, new Date('2026-07-18T00:03:00Z'))

    assert.equal(result.run.status, 'accepted')
    assert.equal(result.run.outcome, 'findings')
    assert.equal(result.state.cursor, context.run.horizon.end)
    assert.deepEqual(result.state.versions, { signals: 1, topics: 1, evidence: 1 })

    const signals = store.listSignals()
    assert.equal(signals.total, 1)
    assert.equal(signals.items[0].openForecastCount, 1)
    assert.equal(signals.items[0].topicCount, 1)
    const signal = store.getSignal(batch.signal_changes[0].signal_id)
    assert.equal(signal.revisions.length, 1)
    assert.equal(signal.evidence.length, 2)
    assert.equal(signal.evidence[0].excerpt, undefined)
    assert.equal(signal.evidence[0].sourceKey, undefined)
    assert.equal(signal.evidence[0].contentHash, undefined)
    assert.equal(Object.hasOwn(signal.evidence[0], 'claim'), true)

    const topics = store.listTopics()
    assert.equal(topics.total, 1)
    assert.equal(topics.items[0].signalCount, 1)
    assert.equal(store.getTopic(batch.topic_changes[0].topic_id).signals[0].id, signal.id)

    const replay = claimFor(store, context, new Date('2026-07-18T00:04:00Z'))
    assert.equal(replay.claimed, false)
    assert.equal(replay.run.id, context.run.id)
  } finally {
    store.close()
  }
})

test('public detail projections hard-bound revision and forecast history', () => {
  const store = createDreamStore(settings(), { databasePath: ':memory:' })
  try {
    const context = fixture('context.json')
    const batch = fixture('finding.json')
    const claim = claimFor(store, context)
    prepare(store, context, claim.leaseToken)
    store.applyBatch({ id: context.run.id, leaseToken: claim.leaseToken, context, batch }, new Date('2026-07-18T00:03:00Z'))

    const signalId = batch.signal_changes[0].signal_id
    const topicId = batch.topic_changes[0].topic_id
    const signalRevision = batch.signal_changes[0].revision.id
    const insertSignalRevision = store.database.prepare('INSERT INTO dream_signal_revisions(id, signal_id, sequence, run_id, payload, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    const insertTopicRevision = store.database.prepare('INSERT INTO dream_topic_revisions(id, topic_id, sequence, run_id, payload, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    const insertForecast = store.database.prepare("INSERT INTO dream_forecasts(id, signal_id, revision_id, claim, due_at, expected_observations, status, created_at) VALUES(?, ?, ?, ?, ?, ?, 'open', ?)")
    store.database.exec('BEGIN IMMEDIATE')
    try {
      for (let sequence = 2; sequence <= 202; sequence += 1) {
        const suffix = String(sequence).padStart(3, '0')
        const createdAt = `2026-07-18T00:${String(sequence % 60).padStart(2, '0')}:00.000Z`
        insertSignalRevision.run(`signal-revision-${suffix}`, signalId, sequence, context.run.id, '{"evidence_ids":[]}', createdAt)
        insertTopicRevision.run(`topic-revision-${suffix}`, topicId, sequence, context.run.id, '{"evidence_ids":[]}', createdAt)
        insertForecast.run(`forecast-${suffix}`, signalId, signalRevision, `forecast ${suffix}`, '2026-08-01T00:00:00.000Z', '[]', createdAt)
      }
      store.database.exec('COMMIT')
    } catch (error) {
      store.database.exec('ROLLBACK')
      throw error
    }

    const signal = store.getSignal(signalId)
    assert.equal(signal.revisions.length, 200)
    assert.equal(signal.forecasts.length, 200)
    assert.equal(signal.detailLimits.truncated.revisions, true)
    assert.equal(signal.detailLimits.truncated.forecasts, true)
    const topic = store.getTopic(topicId)
    assert.equal(topic.revisions.length, 200)
    assert.equal(topic.detailLimits.truncated.revisions, true)
  } finally {
    store.close()
  }
})

test('no-finding advances cursor without creating entity revisions', () => {
  const store = createDreamStore(settings(), { databasePath: ':memory:' })
  try {
    const context = fixture('context.json')
    const claim = claimFor(store, context)
    prepare(store, context, claim.leaseToken)
    const result = store.applyBatch({ id: context.run.id, leaseToken: claim.leaseToken, context, batch: fixture('no-finding.json') }, new Date('2026-07-18T00:03:00Z'))
    assert.equal(result.run.outcome, 'no_finding')
    assert.equal(result.state.cursor, context.run.horizon.end)
    assert.equal(store.listSignals().total, 0)
    assert.equal(store.listTopics().total, 0)
  } finally {
    store.close()
  }
})

test('blocked run is queryable and cannot mutate versions or cursor', () => {
  const store = createDreamStore(settings(), { databasePath: ':memory:' })
  try {
    const context = fixture('context.json')
    const claim = claimFor(store, context)
    const run = store.finishBlocked(context.run.id, claim.leaseToken, 'blocked_incomplete_sources', ['missing final Window'], new Date('2026-07-18T00:03:00Z'))
    assert.equal(run.status, 'blocked')
    assert.deepEqual(store.state(context.run.scope).versions, { signals: 0, topics: 0, evidence: 0 })
    assert.equal(store.state(context.run.scope).cursor, null)
  } finally {
    store.close()
  }
})

test('foreign-key failure halfway through apply rolls back every domain mutation', () => {
  const store = createDreamStore(settings(), { databasePath: ':memory:' })
  try {
    const context = fixture('context.json')
    const batch = fixture('finding.json')
    batch.topic_changes[0].revision.signal_ids = ['sig-ffffffff-ffff-4fff-8fff-ffffffffffff']
    const claim = claimFor(store, context)
    prepare(store, context, claim.leaseToken)
    assert.throws(() => store.applyBatch({ id: context.run.id, leaseToken: claim.leaseToken, context, batch }, new Date('2026-07-18T00:03:00Z')), /FOREIGN KEY/)
    assert.equal(store.listSignals().total, 0)
    assert.equal(store.listTopics().total, 0)
    assert.deepEqual(store.state(context.run.scope).versions, { signals: 0, topics: 0, evidence: 0 })
    assert.equal(store.state(context.run.scope).cursor, null)
  } finally {
    store.close()
  }
})

test('two store instances cannot claim the same live scope and horizon', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vigil-dream-store-'))
  const first = createDreamStore(settings(directory))
  const second = createDreamStore(settings(directory))
  try {
    const context = fixture('context.json')
    const one = claimFor(first, context)
    const two = claimFor(second, context, new Date('2026-07-18T00:01:01Z'))
    assert.equal(one.claimed, true)
    assert.equal(two.claimed, false)
    assert.equal(two.run.status, 'running')
  } finally {
    second.close()
    first.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('stale prepared versions reject commit without moving cursor', () => {
  const store = createDreamStore(settings(), { databasePath: ':memory:' })
  try {
    const context = fixture('context.json')
    const claim = claimFor(store, context)
    prepare(store, context, claim.leaseToken)
    store.database.prepare('UPDATE dream_state SET signal_version = 1 WHERE scope = ?').run(context.run.scope)
    assert.throws(() => store.applyBatch({ id: context.run.id, leaseToken: claim.leaseToken, context, batch: fixture('no-finding.json') }, new Date('2026-07-18T00:03:00Z')), /versions or cursor changed/)
    assert.equal(store.state(context.run.scope).cursor, null)
  } finally {
    store.close()
  }
})
