import assert from 'node:assert/strict'
import express from 'express'
import test from 'node:test'

import { registerDreamRoutes } from '../server/dream-routes.js'

async function withServer(options, operation) {
  const app = express()
  app.use(express.json())
  registerDreamRoutes(app, options)
  app.use((error, _request, response, _next) => response.status(400).json({ error: error.message }))
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  try {
    const address = server.address()
    await operation(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function fixtures({ authenticated = false } = {}) {
  const signalId = 'sig-11111111-1111-4111-8111-111111111111'
  const topicId = 'top-22222222-2222-4222-8222-222222222222'
  const runId = 'run-33333333-3333-4333-8333-333333333333'
  const calls = []
  const store = {
    listSignals: (options) => { calls.push(['signals', options]); return { items: [{ id: signalId }], total: 1, limit: 50, offset: 0 } },
    getSignal: (id) => id === signalId ? { id, title: 'Signal' } : null,
    listSignalRevisions: (id, options) => id === signalId ? { items: [{ id: 'signal-revision' }], total: 1, ...options } : null,
    listSignalForecasts: (id, options) => id === signalId ? { items: [{ id: 'forecast' }], total: 1, ...options } : null,
    listTopics: (options) => { calls.push(['topics', options]); return { items: [{ id: topicId }], total: 1, limit: 50, offset: 0 } },
    getTopic: (id) => id === topicId ? { id, title: 'Topic' } : null,
    listTopicRevisions: (id, options) => id === topicId ? { items: [{ id: 'topic-revision' }], total: 1, ...options } : null,
    listTopicSignals: (id, options) => id === topicId ? { items: [{ id: signalId }], total: 1, ...options } : null,
    listRuns: () => ({ items: [{ id: runId }], total: 1, limit: 50, offset: 0 }),
    getRun: (id, options) => id === runId ? { id, audit: options.includeAudit ? 'visible' : undefined } : null,
  }
  return {
    signalId, topicId, runId, calls,
    options: {
      loadSettings: async () => ({ workspace: { directory: '/tmp/test' } }),
      getStore: () => store,
      scheduler: {
        status: async () => ({ enabled: true, ready: true }),
        trigger: async ({ horizonEnd }) => ({ end: horizonEnd || '2026-07-18T00:00:00.000Z' }),
        retry: async (id) => ({ id, status: 'failed' }),
      },
      authenticationStatus: async () => ({ authenticated }),
    },
  }
}

test('Signal and Topic list/detail routes expose bounded derived projections', async () => {
  const data = fixtures()
  await withServer(data.options, async (base) => {
    const signals = await fetch(`${base}/api/signals?q=ledger&limit=999`).then((response) => response.json())
    assert.equal(signals.total, 1)
    assert.equal(signals.dream.ready, true)
    const signal = await fetch(`${base}/api/signals/${data.signalId}`).then((response) => response.json())
    assert.equal(signal.signal.title, 'Signal')
    const revisions = await fetch(`${base}/api/signals/${data.signalId}/revisions?limit=10&offset=2`).then((response) => response.json())
    assert.equal(revisions.items[0].id, 'signal-revision')
    assert.equal(revisions.limit, 10)
    const forecasts = await fetch(`${base}/api/signals/${data.signalId}/forecasts`).then((response) => response.json())
    assert.equal(forecasts.items[0].id, 'forecast')
    const topic = await fetch(`${base}/api/topics/${data.topicId}`).then((response) => response.json())
    assert.equal(topic.topic.title, 'Topic')
    const topicRevisions = await fetch(`${base}/api/topics/${data.topicId}/revisions`).then((response) => response.json())
    assert.equal(topicRevisions.items[0].id, 'topic-revision')
    const linkedSignals = await fetch(`${base}/api/topics/${data.topicId}/signals`).then((response) => response.json())
    assert.equal(linkedSignals.items[0].id, data.signalId)
    assert.equal(data.calls[0][1].query, 'ledger')
  })
})

test('Dream run raw audit is visible only to authenticated readers', async () => {
  const publicData = fixtures({ authenticated: false })
  await withServer(publicData.options, async (base) => {
    const payload = await fetch(`${base}/api/dream-runs/${publicData.runId}`).then((response) => response.json())
    assert.equal(payload.auditVisible, false)
    assert.equal(payload.run.audit, undefined)
  })
  const adminData = fixtures({ authenticated: true })
  await withServer(adminData.options, async (base) => {
    const payload = await fetch(`${base}/api/dream-runs/${adminData.runId}`).then((response) => response.json())
    assert.equal(payload.auditVisible, true)
    assert.equal(payload.run.audit, 'visible')
  })
})

test('invalid IDs are rejected and trigger/retry delegate to scheduler', async () => {
  const data = fixtures({ authenticated: true })
  await withServer(data.options, async (base) => {
    const invalid = await fetch(`${base}/api/signals/not-an-id`)
    assert.equal(invalid.status, 400)
    const trigger = await fetch(`${base}/api/dream-runs/trigger`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ horizonEnd: '2026-07-18T00:00:00.000Z' }) })
    assert.equal(trigger.status, 202)
    const retry = await fetch(`${base}/api/dream-runs/${data.runId}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(retry.status, 202)
  })
})
