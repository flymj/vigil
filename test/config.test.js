import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeAnalysisSettings } from '../server/config.js'

test('analysis settings disable scheduled windows by default and normalize their limits', () => {
  const settings = normalizeAnalysisSettings({
    windowSchedule: {
      enabled: true,
      timezone: 'America/New_York',
      publishTimes: ['16:00', '08:00', '08:00'],
      repositoryConcurrency: 999,
      maxCatchUpWindows: 0,
      maxAttempts: -1,
    },
  })

  assert.deepEqual(normalizeAnalysisSettings({}).windowSchedule, {
    enabled: false,
    timezone: 'Asia/Shanghai',
    publishTimes: ['00:00', '08:00', '16:00'],
    repositoryConcurrency: 3,
    maxCatchUpWindows: 12,
    maxAttempts: 3,
  })
  assert.deepEqual(settings.windowSchedule, {
    enabled: true,
    timezone: 'America/New_York',
    publishTimes: ['08:00', '16:00'],
    repositoryConcurrency: 8,
    maxCatchUpWindows: 1,
    maxAttempts: 1,
  })
})
