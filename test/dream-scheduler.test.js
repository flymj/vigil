import assert from 'node:assert/strict'
import test from 'node:test'

import { createDreamScheduler } from '../server/dream-scheduler.js'
import { dreamScheduleReadiness } from '../server/dream-schedule.js'

const now = new Date('2026-07-18T00:20:00+08:00')
const horizonEnd = '2026-07-17T16:00:00.000Z'

function settings(overrides = {}) {
  return {
    workspace: { directory: '/tmp/vigil-dream-scheduler' },
    windowSchedule: { enabled: true, timezone: 'Asia/Shanghai', publishTimes: ['00:00', '08:00', '16:00'] },
    dreamSchedule: { enabled: true, timezone: 'Asia/Shanghai', publishDelayMinutes: 10, maxCatchUpDays: 1, maxAttempts: 3, ...overrides },
  }
}

function fakeStore() {
  const runs = []
  return {
    runs,
    state: () => ({ cursor: null, versions: { signals: 0, topics: 0, evidence: 0 } }),
    listRuns: () => ({ items: runs }),
    status: () => ({ state: { cursor: null, versions: { signals: 0, topics: 0, evidence: 0 } }, currentRun: null, lastRun: runs.at(-1) || null }),
    getRun: (id) => runs.find((run) => run.id === id) || null,
    retryable: (id) => runs.some((run) => run.id === id && run.status === 'failed'),
  }
}

function dependencies({ analysisSettings = settings(), windows = [{ rangeEnd: horizonEnd, publishTime: '00:00', status: 'published' }], store = fakeStore(), runner } = {}) {
  return {
    loadSettings: async () => analysisSettings,
    loadRepositories: async () => [],
    loadWindows: async () => windows,
    getStore: () => store,
    runner: runner || { run: async () => ({ status: 'accepted' }) },
    checkReadiness: async (settings) => dreamScheduleReadiness(settings.dreamSchedule, settings.windowSchedule),
    now: () => now,
    timers: { setTimeout: () => 1, clearTimeout: () => {} },
  }
}

test('enabled scheduler queues one eligible durable daily horizon', async () => {
  const calls = []
  const scheduler = createDreamScheduler(dependencies({ runner: { run: async (horizon) => { calls.push(horizon); return { status: 'accepted' } } } }))
  const horizons = await scheduler.start()
  await Promise.resolve()
  assert.equal(horizons.length, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].end, horizonEnd)
  await scheduler.stop()
})

test('disabled or non-midnight Window configuration never auto-queues', async () => {
  let calls = 0
  const disabled = createDreamScheduler(dependencies({ analysisSettings: settings({ enabled: false }), runner: { run: async () => { calls += 1 } } }))
  assert.deepEqual(await disabled.start(), [])
  const notReadySettings = settings()
  notReadySettings.windowSchedule.publishTimes = ['08:00', '16:00']
  const notReady = createDreamScheduler(dependencies({ analysisSettings: notReadySettings, runner: { run: async () => { calls += 1 } } }))
  assert.deepEqual(await notReady.start(), [])
  assert.match((await notReady.status()).reasons.join(' '), /00:00/)
  assert.equal(calls, 0)
  await disabled.stop()
  await notReady.stop()
})

test('two scans while a horizon is active do not double execute', async () => {
  let release
  let calls = 0
  const pending = new Promise((resolve) => { release = resolve })
  const scheduler = createDreamScheduler(dependencies({ runner: { run: async () => { calls += 1; await pending } } }))
  await scheduler.start()
  await scheduler.scan()
  await Promise.resolve()
  assert.equal(calls, 1)
  release()
  await scheduler.stop()
})

test('manual trigger requires a closed horizon with durable midnight Window', async () => {
  const calls = []
  const scheduler = createDreamScheduler(dependencies({ runner: { run: async (horizon) => { calls.push(horizon) } } }))
  const horizon = await scheduler.trigger({ horizonEnd })
  await Promise.resolve()
  assert.equal(horizon.end, horizonEnd)
  assert.equal(calls.length, 1)
  await assert.rejects(() => scheduler.trigger({ horizonEnd: '2099-01-01T00:00:00.000Z' }), /closed daily/)
})

test('manual retry reuses the original failed horizon', async () => {
  const store = fakeStore()
  store.runs.push({ id: 'run-failed', idempotencyKey: 'failed', status: 'failed', attempt: 1, horizon: { start: '2026-07-16T16:00:00.000Z', end: horizonEnd, timezone: 'Asia/Shanghai' }, finishedAt: '2026-07-17T16:15:00.000Z' })
  const calls = []
  const scheduler = createDreamScheduler(dependencies({ store, runner: { run: async (horizon) => { calls.push(horizon) } } }))
  await scheduler.retry('run-failed')
  await Promise.resolve()
  assert.equal(calls[0].end, horizonEnd)
})
