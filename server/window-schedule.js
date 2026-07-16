import { DateTime, IANAZone } from 'luxon'

export const defaultWindowSchedule = Object.freeze({
  enabled: false,
  timezone: 'Asia/Shanghai',
  publishTimes: ['00:00', '08:00', '16:00'],
  repositoryConcurrency: 3,
  maxCatchUpWindows: 12,
  maxAttempts: 3,
})

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function normalizeTimezone(value) {
  const candidate = String(value || '').trim()
  return IANAZone.isValidZone(candidate) ? candidate : defaultWindowSchedule.timezone
}

function validPublishTime(value) {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(String(value || '').trim())
  return match ? match[0] : null
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function boundaryFor(day, publishTime, timezone) {
  const [hour, minute] = publishTime.split(':').map(Number)
  return day.set({ hour, minute, second: 0, millisecond: 0 }).setZone(timezone, { keepLocalTime: true })
}

function asDateTime(value, timezone) {
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: timezone })
  if (typeof value === 'string') return DateTime.fromISO(value, { zone: timezone })
  return DateTime.now().setZone(timezone)
}

export function normalizeWindowSchedule(input = {}) {
  const timezone = normalizeTimezone(input.timezone)
  const requestedTimes = Array.isArray(input.publishTimes) ? input.publishTimes : defaultWindowSchedule.publishTimes
  const publishTimes = [...new Set(requestedTimes.map(validPublishTime).filter(Boolean))]
    .sort((left, right) => timeToMinutes(left) - timeToMinutes(right))

  return {
    enabled: input.enabled === true,
    timezone,
    publishTimes: publishTimes.length ? publishTimes : [...defaultWindowSchedule.publishTimes],
    repositoryConcurrency: boundedInteger(input.repositoryConcurrency, defaultWindowSchedule.repositoryConcurrency, 1, 8),
    maxCatchUpWindows: boundedInteger(input.maxCatchUpWindows, defaultWindowSchedule.maxCatchUpWindows, 1, 96),
    maxAttempts: boundedInteger(input.maxAttempts, defaultWindowSchedule.maxAttempts, 1, 5),
  }
}

export function windowIdForRange({ rangeStart, rangeEnd }) {
  const safe = (value) => String(value).replace(/[:.]/g, '-')
  return `${safe(rangeStart)}__${safe(rangeEnd)}`
}

function scheduledBoundaries(schedule, now, pastDays, futureDays) {
  const localNow = asDateTime(now, schedule.timezone)
  const firstDay = localNow.startOf('day').minus({ days: pastDays })
  const totalDays = pastDays + futureDays + 1
  const boundaries = []

  for (let dayOffset = 0; dayOffset < totalDays; dayOffset += 1) {
    const day = firstDay.plus({ days: dayOffset })
    for (const publishTime of schedule.publishTimes) {
      const boundary = boundaryFor(day, publishTime, schedule.timezone)
      if (boundary.isValid) boundaries.push({ boundary, publishTime })
    }
  }
  return { localNow, boundaries: boundaries.sort((left, right) => left.boundary.toMillis() - right.boundary.toMillis()) }
}

export function completedWindowRanges(input, now = new Date()) {
  const schedule = normalizeWindowSchedule(input)
  const pastDays = Math.ceil(schedule.maxCatchUpWindows / schedule.publishTimes.length) + 2
  const { localNow, boundaries } = scheduledBoundaries(schedule, now, pastDays, 1)
  const closedBoundaries = boundaries.filter(({ boundary }) => boundary.toMillis() <= localNow.toMillis())
  const ranges = []

  for (let index = 1; index < closedBoundaries.length; index += 1) {
    const start = closedBoundaries[index - 1].boundary.toUTC().toISO({ suppressMilliseconds: false })
    const end = closedBoundaries[index].boundary.toUTC().toISO({ suppressMilliseconds: false })
    const range = {
      rangeStart: start,
      rangeEnd: end,
      timezone: schedule.timezone,
      publishTime: closedBoundaries[index].publishTime,
    }
    ranges.push({ id: windowIdForRange(range), ...range })
  }

  return ranges.slice(-schedule.maxCatchUpWindows)
}

export function nextPublishAt(input, now = new Date()) {
  const schedule = normalizeWindowSchedule(input)
  const { localNow, boundaries } = scheduledBoundaries(schedule, now, 0, 2)
  const next = boundaries.find(({ boundary }) => boundary.toMillis() > localNow.toMillis())
  return next ? next.boundary.toUTC().toISO({ suppressMilliseconds: false }) : null
}
