import { completedWindowRanges, nextPublishAt } from './window-schedule.js'

function rangeFromRecord(record) {
  return {
    id: record.id,
    rangeStart: record.rangeStart,
    rangeEnd: record.rangeEnd,
    timezone: record.timezone,
    publishTime: record.publishTime,
  }
}

function dueForRetry(record, timestamp) {
  return record.status === 'failed' && record.nextRetryAt && record.nextRetryAt <= timestamp
}

function runnableRecord(record, timestamp) {
  return record.status === 'queued' || dueForRetry(record, timestamp)
}

export function createWindowScheduler({
  loadSettings,
  loadRepositories,
  runner,
  store,
  events = { publish: () => {} },
  now = () => new Date(),
  timers = { setTimeout, clearTimeout },
}) {
  const activeRuns = new Map()
  let executionQueue = Promise.resolve()
  let timer = null
  let armedNext = null
  let started = false
  let currentSettings = null

  function cancelTimer() {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
    armedNext = null
  }

  async function arm(settings) {
    cancelTimer()
    if (!started || !settings.windowSchedule.enabled) return
    const timestamp = now().toISOString()
    const windows = await store.list()
    const candidates = [nextPublishAt(settings.windowSchedule, now()), ...windows
      .filter((window) => dueForRetry(window, timestamp))
      .map((window) => window.nextRetryAt)]
      .filter(Boolean)
      .sort()
    const next = candidates[0] || null
    if (!next) return
    armedNext = next
    const delay = Math.max(0, new Date(next).getTime() - now().getTime())
    timer = timers.setTimeout(() => {
      timer = null
      armedNext = null
      void scan().catch(() => {})
    }, delay)
  }

  function queueRun(range, settings, repositories) {
    if (activeRuns.has(range.id)) return activeRuns.get(range.id)
    const task = executionQueue.then(() => runner.run(range, settings, repositories))
    executionQueue = task.then(() => undefined, () => undefined)
    activeRuns.set(range.id, task)
    task.finally(() => {
      activeRuns.delete(range.id)
      if (started) void scan().catch(() => {})
    }).catch(() => {})
    return task
  }

  async function eligibleRanges(settings) {
    const timestamp = now().toISOString()
    const records = await store.list()
    const recordsById = new Map(records.map((record) => [record.id, record]))
    const scheduled = completedWindowRanges(settings.windowSchedule, now())
    const ranges = new Map()

    for (const range of scheduled) {
      const record = recordsById.get(range.id)
      if (!record || runnableRecord(record, timestamp)) ranges.set(range.id, { range, record })
    }
    for (const record of records) {
      if (runnableRecord(record, timestamp)) ranges.set(record.id, { range: rangeFromRecord(record), record })
    }
    return [...ranges.values()]
      .filter(({ range }) => !activeRuns.has(range.id))
      .sort((left, right) => left.range.rangeEnd.localeCompare(right.range.rangeEnd))
  }

  async function scan() {
    const settings = await loadSettings()
    currentSettings = settings
    if (!settings.windowSchedule.enabled) {
      cancelTimer()
      return []
    }
    const ranges = await eligibleRanges(settings)
    if (ranges.length) {
      const repositories = await loadRepositories(settings)
      for (const { range, record } of ranges) queueRun(range, settings, record ? record.repositories : repositories)
      await Promise.resolve()
    }
    await arm(settings)
    return ranges.map(({ range }) => range)
  }

  return {
    async start() {
      if (started) return scan()
      started = true
      currentSettings = await loadSettings()
      const recovered = await store.recoverStaleRuns(now())
      for (const record of recovered) {
        const event = record.events?.at(-1)
        if (event) events.publish(event)
      }
      return scan()
    },
    async stop() {
      started = false
      cancelTimer()
    },
    scan,
    async trigger({ rangeEnd } = {}) {
      const settings = await loadSettings()
      currentSettings = settings
      const ranges = completedWindowRanges(settings.windowSchedule, now())
      const range = rangeEnd ? ranges.find((item) => item.rangeEnd === rangeEnd) : ranges.at(-1)
      if (!range) throw new Error('Only a closed Window range can be triggered')
      const records = await store.list()
      const record = records.find((item) => item.id === range.id)
      const repositories = record ? record.repositories : await loadRepositories(settings)
      queueRun(range, settings, repositories)
      await Promise.resolve()
      return range
    },
    async retry(id) {
      const record = await store.retry(id, now())
      if (!record) throw new Error('Window cannot be retried')
      const event = record.events?.at(-1)
      if (event) events.publish(event)
      const settings = await loadSettings()
      currentSettings = settings
      queueRun(rangeFromRecord(record), settings, record.repositories)
      await Promise.resolve()
      return record
    },
    async status() {
      const settings = currentSettings || await loadSettings()
      const windows = await store.list()
      const active = windows.find((window) => window.status === 'running')
        || [...activeRuns.keys()].map((id) => ({ id, status: 'running' }))[0]
        || null
      return {
        enabled: settings.windowSchedule.enabled,
        timezone: settings.windowSchedule.timezone,
        publishTimes: settings.windowSchedule.publishTimes,
        nextPublishAt: settings.windowSchedule.enabled ? armedNext || nextPublishAt(settings.windowSchedule, now()) : null,
        currentRun: active,
        lastWindow: windows.find((window) => ['published', 'degraded', 'failed'].includes(window.status)) || null,
      }
    },
  }
}
