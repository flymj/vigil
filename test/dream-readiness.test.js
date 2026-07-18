import assert from 'node:assert/strict'
import test from 'node:test'

import { DREAM_MINIMUM_NODE, dreamRuntimeCompatibility, supportsDreamNode } from '../server/dream-compatibility.js'
import { dreamOperationalReadiness } from '../server/dream-readiness.js'

function settings(overrides = {}) {
  return {
    windowSchedule: { enabled: true, timezone: 'Asia/Shanghai', publishTimes: ['00:00', '08:00'] },
    dreamSchedule: { enabled: true, timezone: 'Asia/Shanghai' },
    provider: { baseUrl: 'http://127.0.0.1:9000/v1', model: 'test', requiresApiKey: false },
    ...overrides,
  }
}

test('Dream declares and checks the supported Node runtime boundary', () => {
  assert.equal(DREAM_MINIMUM_NODE.label, '24.15.0')
  assert.equal(supportsDreamNode('24.14.9'), false)
  assert.equal(supportsDreamNode('24.15.0'), true)
  assert.equal(supportsDreamNode('26.0.0'), true)
  assert.equal(dreamRuntimeCompatibility().ready, true)
})

test('operational readiness includes Window, runtime, and Provider requirements', async () => {
  const ready = await dreamOperationalReadiness(settings())
  assert.equal(ready.ready, true)
  assert.equal(ready.providerReady, true)
  assert.equal(ready.runtime.sqliteAvailable, true)

  const unavailable = await dreamOperationalReadiness(settings({
    windowSchedule: { enabled: false, timezone: 'Asia/Shanghai', publishTimes: ['08:00'] },
    provider: { baseUrl: '', model: '', requiresApiKey: false },
  }))
  assert.equal(unavailable.ready, false)
  assert.match(unavailable.reasons.join(' '), /Window schedule is disabled/)
  assert.match(unavailable.reasons.join(' '), /Provider base URL and model/)
})
