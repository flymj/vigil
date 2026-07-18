import { closedDailyHorizons, dreamIdempotencyKey, nextDreamAt } from './dream-schedule.js'
import { dreamScope } from './dream-context.js'
import { dreamOperationalReadiness } from './dream-readiness.js'
import { safeDreamError } from './dream-safety.js'

function retryAt(run) {
  if (!run?.finishedAt || !['failed', 'blocked'].includes(run.status)) return null
  const delay = 5 * 60 * 1000 * (2 ** Math.max(0, Number(run.attempt || 1) - 1))
  return new Date(new Date(run.finishedAt).getTime() + delay).toISOString()
}

export function createDreamScheduler({
  loadSettings,
  loadRepositories,
  loadWindows,
  getStore,
  runner,
  checkReadiness = dreamOperationalReadiness,
  now = () => new Date(),
  timers = { setTimeout, clearTimeout },
}) {
  const active = new Map()
  let executionQueue = Promise.resolve()
  let timer = null
  let armedNext = null
  let started = false
  let currentSettings = null
  let storageError = ''

  function cancelTimer() {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
    armedNext = null
  }

  async function eligible(settings, { includeRetryDelay = true } = {}) {
    const readiness = await checkReadiness(settings)
    if (!readiness.ready) return []
    const scope = dreamScope(settings)
    const store = getStore(settings)
    const windows = await loadWindows(settings)
    const records = store.listRuns({ scope, limit: 100 }).items
    const byKey = new Map(records.map((record) => [record.idempotencyKey, record]))
    const cursor = store.state(scope).cursor
    const timestamp = now().toISOString()
    return closedDailyHorizons(settings.dreamSchedule, now())
      .filter((horizon) => !cursor || horizon.end > cursor)
      .filter((horizon) => windows.some((window) => window.rangeEnd === horizon.end && window.publishTime === '00:00' && ['published', 'degraded'].includes(window.status)))
      .filter((horizon) => {
        const record = byKey.get(dreamIdempotencyKey(scope, horizon.end))
        if (!record) return true
        if (record.status === 'accepted' || record.status === 'running') return false
        if (record.attempt >= settings.dreamSchedule.maxAttempts) return false
        return !includeRetryDelay || !retryAt(record) || retryAt(record) <= timestamp
      })
      .sort((left, right) => left.end.localeCompare(right.end))
  }

  function queue(horizon, settings, repositories) {
    if (active.has(horizon.end)) return active.get(horizon.end)
    const task = executionQueue.then(() => runner.run(horizon, settings, repositories))
    executionQueue = task.then(() => undefined, () => undefined)
    active.set(horizon.end, task)
    task.finally(() => {
      active.delete(horizon.end)
      if (started) void scan().catch(() => {})
    }).catch(() => {})
    return task
  }

  async function arm(settings, readiness = null) {
    cancelTimer()
    if (!started || !settings.dreamSchedule.enabled) return
    const effectiveReadiness = readiness || await checkReadiness(settings)
    if (!effectiveReadiness.ready || storageError) return
    const store = getStore(settings)
    const scope = dreamScope(settings)
    const retries = store.listRuns({ scope, limit: 100 }).items
      .filter((run) => ['failed', 'blocked'].includes(run.status) && run.attempt < settings.dreamSchedule.maxAttempts)
      .map(retryAt)
      .filter((value) => value && value > now().toISOString())
    const candidates = [nextDreamAt(settings.dreamSchedule, now()), ...retries].filter(Boolean).sort()
    armedNext = candidates[0] || null
    if (!armedNext) return
    timer = timers.setTimeout(() => {
      timer = null
      armedNext = null
      void scan().catch(() => {})
    }, Math.max(0, new Date(armedNext).getTime() - now().getTime()))
  }

  async function scan() {
    const settings = await loadSettings()
    currentSettings = settings
    if (!settings.dreamSchedule.enabled) {
      cancelTimer()
      return []
    }
    const readiness = await checkReadiness(settings)
    if (!readiness.ready) {
      cancelTimer()
      return []
    }
    try {
      const horizons = await eligible(settings)
      storageError = ''
      if (horizons.length) {
        const repositories = await loadRepositories(settings)
        for (const horizon of horizons) queue(horizon, settings, repositories)
        await Promise.resolve()
      }
      await arm(settings, readiness)
      return horizons
    } catch (error) {
      storageError = safeDreamError(error)
      cancelTimer()
      return []
    }
  }

  return {
    async start() {
      if (started) return scan()
      started = true
      return scan()
    },
    async stop() {
      started = false
      cancelTimer()
    },
    scan,
    async trigger({ horizonEnd } = {}) {
      const settings = await loadSettings()
      currentSettings = settings
      const readiness = await checkReadiness(settings)
      if (!readiness.ready) throw new Error(readiness.reasons.join('; '))
      const horizons = closedDailyHorizons(settings.dreamSchedule, now())
      const horizon = horizonEnd ? horizons.find((item) => item.end === horizonEnd) : horizons.at(-1)
      if (!horizon) throw new Error('Only a closed daily Dream horizon can be triggered')
      const windows = await loadWindows(settings)
      if (!windows.some((window) => window.rangeEnd === horizon.end && window.publishTime === '00:00' && ['published', 'degraded'].includes(window.status))) throw new Error('The daily horizon does not have a durable midnight Window')
      const repositories = await loadRepositories(settings)
      queue(horizon, settings, repositories)
      await Promise.resolve()
      return horizon
    },
    async retry(id) {
      const settings = await loadSettings()
      currentSettings = settings
      const readiness = await checkReadiness(settings)
      if (!readiness.ready) throw new Error(readiness.reasons.join('; '))
      const store = getStore(settings)
      const record = store.getRun(id)
      if (!record || !store.retryable(id)) throw new Error('Dream run cannot be retried')
      const horizon = record.horizon
      const repositories = await loadRepositories(settings)
      queue(horizon, settings, repositories)
      await Promise.resolve()
      return record
    },
    async status() {
      const settings = currentSettings || await loadSettings()
      const readiness = await checkReadiness(settings)
      const scope = dreamScope(settings)
      let status = { state: { cursor: null, versions: { signals: 0, topics: 0, evidence: 0 } }, currentRun: null, lastRun: null }
      if (readiness.runtime?.ready !== false) {
        try {
          status = getStore(settings).status(scope)
          storageError = ''
        } catch (error) {
          storageError = safeDreamError(error)
        }
      }
      const reasons = [...readiness.reasons, ...(storageError ? [`Dream ledger is unavailable: ${storageError}`] : [])]
      return {
        enabled: settings.dreamSchedule.enabled,
        ready: readiness.ready && !storageError,
        reasons,
        runtime: readiness.runtime || null,
        providerReady: readiness.providerReady !== false,
        storageReady: !storageError && readiness.runtime?.ready !== false,
        timezone: settings.dreamSchedule.timezone,
        nextRunAt: settings.dreamSchedule.enabled && readiness.ready && !storageError ? armedNext || nextDreamAt(settings.dreamSchedule, now()) : null,
        currentRun: status.currentRun || ([...active.keys()][0] ? { horizon: { end: [...active.keys()][0] }, status: 'running' } : null),
        lastRun: status.lastRun,
        cursor: status.state.cursor,
        versions: status.state.versions,
      }
    },
  }
}
