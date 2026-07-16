import assert from 'node:assert/strict'
import test from 'node:test'

import { createWindowScheduler } from '../server/window-scheduler.js'

const settings = {
  windowSchedule: {
    enabled: true,
    timezone: 'Asia/Shanghai',
    publishTimes: ['00:00', '08:00', '16:00'],
    repositoryConcurrency: 1,
    maxCatchUpWindows: 1,
    maxAttempts: 3,
  },
}

function schedulerHarness() {
  const ranges = []
  const timers = []
  const store = {
    recoverStaleRuns: async () => [],
    list: async () => [],
    retry: async () => null,
  }
  const runner = { run: async (range) => { ranges.push(range); return { id: range.id, status: 'published' } } }
  const scheduler = createWindowScheduler({
    loadSettings: async () => settings,
    loadRepositories: async () => [{ id: 'repo', project: 'openai/example', sourceType: 'github' }],
    runner,
    store,
    now: () => new Date('2026-07-16T00:01:00.000Z'),
    timers: {
      setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
      clearTimeout: () => {},
    },
  })
  return { scheduler, ranges, timers }
}

test('startup queues a closed missed Window but never the current unfinished interval', async () => {
  const { scheduler, ranges, timers } = schedulerHarness()
  await scheduler.start()
  await Promise.resolve()

  assert.deepEqual(ranges.map((range) => range.rangeEnd), ['2026-07-16T00:00:00.000Z'])
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delay, 7 * 60 * 60 * 1000 + 59 * 60 * 1000)
  await scheduler.stop()
})

test('trigger does not queue the same Window twice while its first run is active', async () => {
  const ranges = []
  let resolveRun
  const runner = { run: async (range) => {
    ranges.push(range)
    await new Promise((resolve) => { resolveRun = resolve })
    return { id: range.id, status: 'published' }
  } }
  const scheduler = createWindowScheduler({
    loadSettings: async () => settings,
    loadRepositories: async () => [],
    runner,
    store: { recoverStaleRuns: async () => [], list: async () => [], retry: async () => null },
    now: () => new Date('2026-07-16T00:01:00.000Z'),
    timers: { setTimeout: () => 1, clearTimeout: () => {} },
  })
  const request = { rangeEnd: '2026-07-16T00:00:00.000Z' }

  await scheduler.trigger(request)
  await scheduler.trigger(request)
  await Promise.resolve()
  assert.equal(ranges.length, 1)
  resolveRun()
  await scheduler.stop()
})

test('trigger rejects an unfinished current Window range', async () => {
  const { scheduler } = schedulerHarness()
  await assert.rejects(
    scheduler.trigger({ rangeEnd: '2026-07-16T08:00:00.000Z' }),
    /closed Window/,
  )
  await scheduler.stop()
})
