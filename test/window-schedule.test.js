import assert from 'node:assert/strict'
import test from 'node:test'

import { completedWindowRanges, nextPublishAt, normalizeWindowSchedule } from '../server/window-schedule.js'

test('default schedule closes the three Shanghai windows with half-open UTC ranges', () => {
  const schedule = normalizeWindowSchedule({ enabled: true })
  const now = new Date('2026-07-16T00:01:00.000Z')
  const ranges = completedWindowRanges(schedule, now)

  assert.deepEqual(ranges.at(-1), {
    id: '2026-07-15T16-00-00-000Z__2026-07-16T00-00-00-000Z',
    rangeStart: '2026-07-15T16:00:00.000Z',
    rangeEnd: '2026-07-16T00:00:00.000Z',
    timezone: 'Asia/Shanghai',
    publishTime: '08:00',
  })
})

test('schedule canonicalizes valid times and retains safe defaults', () => {
  assert.deepEqual(
    normalizeWindowSchedule({ publishTimes: ['16:00', '00:00', '16:00'] }).publishTimes,
    ['00:00', '16:00'],
  )
  assert.equal(normalizeWindowSchedule({ timezone: 'not/a-zone' }).timezone, 'Asia/Shanghai')
  assert.equal(normalizeWindowSchedule({}).enabled, false)
})

test('next publish boundary is the next configured slot in the selected timezone', () => {
  const schedule = normalizeWindowSchedule({ enabled: true })
  assert.equal(nextPublishAt(schedule, new Date('2026-07-16T00:01:00.000Z')), '2026-07-16T08:00:00.000Z')
})
