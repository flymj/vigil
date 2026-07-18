import { DateTime, IANAZone } from 'luxon'

export const defaultDreamSchedule = Object.freeze({
  enabled: false,
  timezone: 'Asia/Shanghai',
  publishDelayMinutes: 10,
  maxCatchUpDays: 7,
  maxAttempts: 3,
  leaseSeconds: 900,
  maxCandidates: 4,
  maxEvidenceRequests: 6,
  maxSignalChanges: 3,
  maxTopicChanges: 2,
  scoutMaxOutputTokens: 4_000,
  maxOutputTokens: 16_000,
  contextMaxChars: 180_000,
})

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function timezone(value, fallback) {
  const candidate = String(value || '').trim()
  return IANAZone.isValidZone(candidate) ? candidate : fallback
}

export function normalizeDreamSchedule(input = {}, windowSchedule = {}) {
  const inheritedTimezone = timezone(windowSchedule.timezone, defaultDreamSchedule.timezone)
  return {
    enabled: input.enabled === true,
    timezone: timezone(input.timezone, inheritedTimezone),
    publishDelayMinutes: boundedInteger(input.publishDelayMinutes, defaultDreamSchedule.publishDelayMinutes, 0, 240),
    maxCatchUpDays: boundedInteger(input.maxCatchUpDays, defaultDreamSchedule.maxCatchUpDays, 1, 90),
    maxAttempts: boundedInteger(input.maxAttempts, defaultDreamSchedule.maxAttempts, 1, 5),
    leaseSeconds: boundedInteger(input.leaseSeconds, defaultDreamSchedule.leaseSeconds, 30, 7200),
    maxCandidates: boundedInteger(input.maxCandidates, defaultDreamSchedule.maxCandidates, 1, 8),
    maxEvidenceRequests: boundedInteger(input.maxEvidenceRequests, defaultDreamSchedule.maxEvidenceRequests, 0, 12),
    maxSignalChanges: boundedInteger(input.maxSignalChanges, defaultDreamSchedule.maxSignalChanges, 0, 8),
    maxTopicChanges: boundedInteger(input.maxTopicChanges, defaultDreamSchedule.maxTopicChanges, 0, 4),
    scoutMaxOutputTokens: boundedInteger(input.scoutMaxOutputTokens, defaultDreamSchedule.scoutMaxOutputTokens, 512, 16_000),
    maxOutputTokens: boundedInteger(input.maxOutputTokens, defaultDreamSchedule.maxOutputTokens, 1_024, 64_000),
    contextMaxChars: boundedInteger(input.contextMaxChars, defaultDreamSchedule.contextMaxChars, 20_000, 1_000_000),
  }
}

function asDateTime(value, zone) {
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone })
  if (typeof value === 'string') return DateTime.fromISO(value, { zone })
  return DateTime.now().setZone(zone)
}

export function dreamScheduleReadiness(dreamSchedule, windowSchedule) {
  const dream = normalizeDreamSchedule(dreamSchedule, windowSchedule)
  const reasons = []
  if (!windowSchedule?.enabled) reasons.push('Window schedule is disabled')
  if (!(windowSchedule?.publishTimes || []).includes('00:00')) reasons.push('Window schedule must include the 00:00 boundary')
  if (dream.timezone !== windowSchedule?.timezone) reasons.push('Dream and Window schedules must use the same timezone')
  return { ready: reasons.length === 0, reasons, schedule: dream }
}

export function closedDailyHorizons(input, now = new Date()) {
  const schedule = normalizeDreamSchedule(input)
  const localNow = asDateTime(now, schedule.timezone)
  const latestBoundary = localNow.startOf('day')
  const latestEligibleAt = latestBoundary.plus({ minutes: schedule.publishDelayMinutes })
  const end = localNow.toMillis() >= latestEligibleAt.toMillis() ? latestBoundary : latestBoundary.minus({ days: 1 })
  return Array.from({ length: schedule.maxCatchUpDays }, (_, index) => {
    const horizonEnd = end.minus({ days: schedule.maxCatchUpDays - index - 1 })
    return {
      start: horizonEnd.minus({ days: 1 }).toUTC().toISO({ suppressMilliseconds: false }),
      end: horizonEnd.toUTC().toISO({ suppressMilliseconds: false }),
      timezone: schedule.timezone,
    }
  })
}

export function nextDreamAt(input, now = new Date()) {
  const schedule = normalizeDreamSchedule(input)
  const localNow = asDateTime(now, schedule.timezone)
  let next = localNow.startOf('day').plus({ minutes: schedule.publishDelayMinutes })
  if (next.toMillis() <= localNow.toMillis()) next = next.plus({ days: 1 })
  return next.toUTC().toISO({ suppressMilliseconds: false })
}

export function dreamIdempotencyKey(scope, horizonEnd) {
  return `${scope}:${horizonEnd}:dream-v2.1`
}
