import assert from 'node:assert/strict'
import test from 'node:test'

import { getDreamRun, getDreamRuns, getSignal, getSignalForecasts, getSignalRevisions, getSignals, getTopic, getTopicRevisions, getTopics, getTopicSignals, retryDreamRun, triggerDream } from '../src/api.js'

test('Dream API client maps list, detail, trigger, and retry endpoints', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (path, options = {}) => {
    requests.push({ path, options })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    await getSignals({ query: 'ledger', status: 'active', limit: 20 })
    await getSignal('sig/one')
    await getSignalRevisions('sig/one', { limit: 20 })
    await getSignalForecasts('sig/one', { offset: 10 })
    await getTopics({ offset: 10 })
    await getTopic('top/one')
    await getTopicRevisions('top/one', { limit: 20 })
    await getTopicSignals('top/one', { offset: 10 })
    await getDreamRuns({ status: 'blocked' })
    await getDreamRun('run/one')
    await triggerDream('2026-07-18T00:00:00.000Z')
    await retryDreamRun('run/one')

    assert.deepEqual(requests.map(({ path, options }) => [path, options.method || 'GET']), [
      ['/api/signals?q=ledger&status=active&limit=20', 'GET'],
      ['/api/signals/sig%2Fone', 'GET'],
      ['/api/signals/sig%2Fone/revisions?limit=20', 'GET'],
      ['/api/signals/sig%2Fone/forecasts?offset=10', 'GET'],
      ['/api/topics?offset=10', 'GET'],
      ['/api/topics/top%2Fone', 'GET'],
      ['/api/topics/top%2Fone/revisions?limit=20', 'GET'],
      ['/api/topics/top%2Fone/signals?offset=10', 'GET'],
      ['/api/dream-runs?status=blocked', 'GET'],
      ['/api/dream-runs/run%2Fone', 'GET'],
      ['/api/dream-runs/trigger', 'POST'],
      ['/api/dream-runs/run%2Fone/retry', 'POST'],
    ])
    assert.equal(requests[10].options.body, JSON.stringify({ horizonEnd: '2026-07-18T00:00:00.000Z' }))
  } finally {
    globalThis.fetch = originalFetch
  }
})
