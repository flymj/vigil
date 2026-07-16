import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

let windowMutationQueue = Promise.resolve()

function ledgerPath(settings) {
  return path.join(settings.workspace.directory, 'window-runs.json')
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function isoAt(value) {
  return value instanceof Date ? value.toISOString() : new Date(value || Date.now()).toISOString()
}

function safeText(value, maxLength = 600) {
  if (value === null || value === undefined) return undefined
  return String(value).trim().slice(0, maxLength)
}

function safeRepository(repository) {
  const allowed = ['id', 'name', 'org', 'initial', 'color', 'weight', 'criticalPaths', 'syncMode', 'syncStatus', 'localPath', 'sourceType', 'host', 'project', 'branch', 'defaultBranch', 'cloneUrl', 'browseUrl', 'apiBaseUrl']
  return Object.fromEntries(allowed.filter((key) => repository[key] !== undefined).map((key) => [key, repository[key]]))
}

function normalizeEvent(windowId, event, sequence, at) {
  const normalized = {
    windowId,
    sequence,
    at: isoAt(at),
    type: safeText(event.type, 120) || 'window.unknown',
  }
  for (const key of ['repositoryId', 'repository', 'stage', 'message', 'status']) {
    const value = safeText(event[key], key === 'message' ? 600 : 240)
    if (value) normalized[key] = value
  }
  const elapsedMs = Number(event.elapsedMs)
  if (Number.isFinite(elapsedMs) && elapsedMs >= 0) normalized.elapsedMs = Math.round(elapsedMs)
  const attempt = Number(event.attempt)
  if (Number.isInteger(attempt) && attempt > 0) normalized.attempt = attempt
  return normalized
}

async function readLedger(settings) {
  try {
    const payload = JSON.parse(await readFile(ledgerPath(settings), 'utf8'))
    return { version: 1, windows: Array.isArray(payload.windows) ? payload.windows : [] }
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, windows: [] }
    throw error
  }
}

async function writeLedger(settings, ledger) {
  const target = ledgerPath(settings)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(settings.workspace.directory, { recursive: true, mode: 0o700 })
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

function serializeMutation(operation) {
  const result = windowMutationQueue.then(operation, operation)
  windowMutationQueue = result.then(() => undefined, () => undefined)
  return result
}

function createRecord(range, repositories, now) {
  return {
    version: 1,
    id: range.id,
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    timezone: range.timezone,
    publishTime: range.publishTime,
    status: 'queued',
    attempt: 0,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    nextRetryAt: null,
    repositories: repositories.map(safeRepository),
    repositoryRuns: [],
    events: [],
    artifact: null,
    report: null,
    error: null,
  }
}

function appendRecordEvent(record, event, now) {
  const normalized = normalizeEvent(record.id, event, record.events.length + 1, now)
  record.events.push(normalized)
  return normalized
}

export function createWindowStore(settings) {
  return {
    async list() {
      const ledger = await readLedger(settings)
      return clone([...ledger.windows].sort((left, right) => right.rangeEnd.localeCompare(left.rangeEnd)))
    },
    async load(id) {
      const ledger = await readLedger(settings)
      const record = ledger.windows.find((window) => window.id === id)
      return record ? clone(record) : null
    },
    async claim(range, repositories = [], now = new Date()) {
      return serializeMutation(async () => {
        const ledger = await readLedger(settings)
        const timestamp = isoAt(now)
        let record = ledger.windows.find((window) => window.id === range.id)
        if (!record) {
          record = createRecord(range, repositories, timestamp)
          ledger.windows.push(record)
        }
        const retryDue = record.status === 'failed' && record.nextRetryAt && record.nextRetryAt <= timestamp
        if (record.status !== 'queued' && !retryDue) return null

        record.status = 'running'
        record.attempt += 1
        record.startedAt = timestamp
        record.finishedAt = null
        record.nextRetryAt = null
        record.repositoryRuns = []
        record.error = null
        if (repositories.length) record.repositories = repositories.map(safeRepository)
        await writeLedger(settings, ledger)
        return clone(record)
      })
    },
    async appendEvent(id, event, now = new Date()) {
      return serializeMutation(async () => {
        const ledger = await readLedger(settings)
        const record = ledger.windows.find((window) => window.id === id)
        if (!record) throw new Error('Window not found')
        const stored = appendRecordEvent(record, event, now)
        await writeLedger(settings, ledger)
        return clone(stored)
      })
    },
    async finish(id, outcome, now = new Date()) {
      return serializeMutation(async () => {
        const ledger = await readLedger(settings)
        const record = ledger.windows.find((window) => window.id === id)
        if (!record) throw new Error('Window not found')
        if (record.status !== 'running') throw new Error('Window is not running')
        if (!['published', 'degraded', 'failed'].includes(outcome.status)) throw new Error('Invalid Window outcome')

        record.status = outcome.status
        record.finishedAt = isoAt(now)
        record.nextRetryAt = outcome.nextRetryAt || null
        record.repositoryRuns = clone(outcome.repositoryRuns || [])
        record.artifact = outcome.artifact ? clone(outcome.artifact) : null
        record.report = outcome.report ? clone(outcome.report) : null
        record.error = safeText(outcome.error)
        const event = outcome.event ? appendRecordEvent(record, outcome.event, now) : null
        await writeLedger(settings, ledger)
        return { record: clone(record), event: event ? clone(event) : null }
      })
    },
    async recoverStaleRuns(now = new Date()) {
      return serializeMutation(async () => {
        const ledger = await readLedger(settings)
        const recovered = []
        for (const record of ledger.windows) {
          if (record.status !== 'running') continue
          record.status = 'queued'
          record.finishedAt = null
          record.nextRetryAt = null
          record.repositoryRuns = []
          record.error = null
          appendRecordEvent(record, { type: 'window.recovered', status: 'queued', attempt: record.attempt }, now)
          recovered.push(clone(record))
        }
        if (recovered.length) await writeLedger(settings, ledger)
        return recovered
      })
    },
    async retry(id, now = new Date()) {
      return serializeMutation(async () => {
        const ledger = await readLedger(settings)
        const record = ledger.windows.find((window) => window.id === id)
        if (!record || record.status !== 'failed' || record.nextRetryAt) return null
        record.status = 'queued'
        record.finishedAt = null
        record.error = null
        record.repositoryRuns = []
        appendRecordEvent(record, { type: 'window.retry.queued', status: 'queued', attempt: record.attempt }, now)
        await writeLedger(settings, ledger)
        return clone(record)
      })
    },
  }
}
