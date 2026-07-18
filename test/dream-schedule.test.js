import assert from 'node:assert/strict'
import test from 'node:test'

import { closedDailyHorizons, dreamIdempotencyKey, dreamScheduleReadiness, nextDreamAt, normalizeDreamSchedule } from '../server/dream-schedule.js'

test('Dream schedule normalizes bounded operational limits', () => {
  const schedule = normalizeDreamSchedule({ enabled: true, maxCandidates: 999, maxEvidenceRequests: -1, maxOutputTokens: 999_999, contextMaxChars: 1 }, { timezone: 'Asia/Shanghai' })
  assert.equal(schedule.enabled, true)
  assert.equal(schedule.maxCandidates, 8)
  assert.equal(schedule.maxEvidenceRequests, 0)
  assert.equal(schedule.maxOutputTokens, 64_000)
  assert.equal(schedule.contextMaxChars, 20_000)
})

test('automatic Dream readiness requires enabled Window and midnight boundary', () => {
  assert.deepEqual(dreamScheduleReadiness({ enabled: true }, { enabled: true, timezone: 'Asia/Shanghai', publishTimes: ['00:00', '08:00'] }).reasons, [])
  const result = dreamScheduleReadiness({ enabled: true }, { enabled: true, timezone: 'Asia/Shanghai', publishTimes: ['08:00', '16:00'] })
  assert.equal(result.ready, false)
  assert.match(result.reasons.join(' '), /00:00/)
})

test('closed horizon is previous local calendar day after publish delay', () => {
  const horizons = closedDailyHorizons({ timezone: 'Asia/Shanghai', publishDelayMinutes: 10, maxCatchUpDays: 2 }, new Date('2026-07-18T00:20:00+08:00'))
  assert.deepEqual(horizons.at(-1), { start: '2026-07-16T16:00:00.000Z', end: '2026-07-17T16:00:00.000Z', timezone: 'Asia/Shanghai' })
})

test('before publish delay the latest horizon remains pending', () => {
  const horizons = closedDailyHorizons({ timezone: 'Asia/Shanghai', publishDelayMinutes: 10, maxCatchUpDays: 1 }, new Date('2026-07-18T00:05:00+08:00'))
  assert.equal(horizons[0].end, '2026-07-16T16:00:00.000Z')
  assert.equal(nextDreamAt({ timezone: 'Asia/Shanghai', publishDelayMinutes: 10 }, new Date('2026-07-18T00:05:00+08:00')), '2026-07-17T16:10:00.000Z')
})

test('DST-observing timezone derives local-midnight horizons rather than fixed 24-hour UTC math', () => {
  const horizons = closedDailyHorizons({ timezone: 'America/New_York', publishDelayMinutes: 0, maxCatchUpDays: 1 }, new Date('2026-03-09T01:00:00-04:00'))
  assert.deepEqual(horizons[0], { start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z', timezone: 'America/New_York' })
})

test('idempotency identity is stable per scope, horizon, and protocol', () => {
  assert.equal(dreamIdempotencyKey('workspace:a', '2026-07-18T00:00:00.000Z'), 'workspace:a:2026-07-18T00:00:00.000Z:dream-v2.1')
})
