import { providerCredentialStatus } from './config.js'
import { executeRepositorySummary, executeWindowSummary } from './provider.js'
import { structuredRepositorySummary, persistRepositorySummary } from './reports.js'
import { collectSourceWindow } from './repository-intelligence.js'
import { updateWatchedRepository } from './repository-store.js'
import { syncFullRepository } from './repository-sync.js'
import { persistWindowReport, structuredWindowSummary } from './window-reports.js'
import { sanitizeWindowText } from './window-safety.js'

function safeError(error) {
  return sanitizeWindowText(error?.message || error || 'Unknown error') || 'Unknown error'
}

function repositoryLabel(repository) {
  return repository.project || repository.name || repository.id
}

function asDate(value) {
  return value instanceof Date ? value : new Date(value)
}

function retryAt(now, attempt) {
  return new Date(asDate(now).getTime() + (5 * 60 * 1000 * (2 ** Math.max(0, attempt - 1)))).toISOString()
}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(items[index])
    }
  }))
  return results
}

export function createWindowRunner({
  store,
  events,
  now = () => new Date(),
  collect = collectSourceWindow,
  sync = syncFullRepository,
  updateRepository = updateWatchedRepository,
  summarize = executeRepositorySummary,
  providerStatus = providerCredentialStatus,
  aggregate = executeWindowSummary,
  persistSummary = persistRepositorySummary,
  persistWindow = persistWindowReport,
}) {
  async function emit(windowId, event) {
    const stored = await store.appendEvent(windowId, event, now())
    events.publish(stored)
    return stored
  }

  async function providerIsReady(settings) {
    try {
      return Boolean((await providerStatus(settings)).providerReady)
    } catch {
      return false
    }
  }

  async function processRepository(window, settings, repository) {
    const label = repositoryLabel(repository)
    let stage = 'sync'
    const startedAt = performance.now()
    try {
      await emit(window.id, { type: 'repository.sync.started', repositoryId: repository.id, repository: label, stage })
      if (repository.syncMode === 'full') {
        const result = await sync(settings, repository)
        await updateRepository(settings, repository.id, {
          syncStatus: 'ready',
          localPath: result.localPath,
          lastFullSync: result.syncedAt,
          headSha: result.headSha,
          syncError: '',
        })
        await emit(window.id, { type: 'repository.sync.succeeded', repositoryId: repository.id, repository: label, stage, elapsedMs: performance.now() - startedAt })
      } else {
        await emit(window.id, { type: 'repository.sync.succeeded', repositoryId: repository.id, repository: label, stage: 'metadata', elapsedMs: performance.now() - startedAt })
      }

      stage = 'collect'
      await emit(window.id, { type: 'repository.collect.started', repositoryId: repository.id, repository: label, stage })
      const snapshot = await collect(settings, repository, { from: window.rangeStart, to: window.rangeEnd })
      await emit(window.id, { type: 'repository.collect.succeeded', repositoryId: repository.id, repository: label, stage, elapsedMs: performance.now() - startedAt })

      stage = 'summary'
      await emit(window.id, { type: 'repository.summary.started', repositoryId: repository.id, repository: label, stage })
      let analysis = structuredRepositorySummary(snapshot)
      let analysisError = null
      if (await providerIsReady(settings)) {
        try {
          analysis = await summarize(settings, snapshot)
        } catch (error) {
          analysisError = safeError(error)
          await emit(window.id, { type: 'repository.summary.failed', repositoryId: repository.id, repository: label, stage, message: analysisError, status: 'fallback' })
        }
      }
      const report = { snapshot, analysis, analysisError, generatedAt: asDate(now()).toISOString() }
      const artifact = await persistSummary(settings, report)
      await emit(window.id, { type: 'repository.summary.succeeded', repositoryId: repository.id, repository: label, stage, status: analysis.mode, elapsedMs: performance.now() - startedAt })
      return {
        repositoryId: repository.id,
        repository: snapshot.repository || label,
        status: 'succeeded',
        counts: snapshot.counts,
        snapshot,
        report: { analysis, analysisError, generatedAt: report.generatedAt },
        artifactId: artifact.artifactId,
      }
    } catch (error) {
      const message = safeError(error)
      if (repository.syncMode === 'full' && stage === 'sync') {
        try {
          await updateRepository(settings, repository.id, { syncStatus: 'failed', syncError: message })
        } catch {
          // The source sync failure remains the actionable result.
        }
      }
      await emit(window.id, { type: `repository.${stage}.failed`, repositoryId: repository.id, repository: label, stage, message, elapsedMs: performance.now() - startedAt })
      return { repositoryId: repository.id, repository: label, status: 'failed', stage, error: message }
    }
  }

  async function finishWithFailure(window, settings, repositoryRuns, error) {
    const message = safeError(error)
    const failure = { ...window, status: 'failed', repositoryRuns }
    const report = { generatedAt: asDate(now()).toISOString(), analysis: structuredWindowSummary(failure), analysisError: message }
    let artifact = null
    try {
      artifact = await persistWindow(settings, failure, report)
    } catch {
      // The ledger still records a retriable Window if its artifact directory is unavailable.
    }
    const nextRetryAt = window.attempt < settings.windowSchedule.maxAttempts ? retryAt(now(), window.attempt) : null
    const finished = await store.finish(window.id, {
      status: 'failed',
      repositoryRuns,
      report,
      artifact,
      error: message,
      nextRetryAt,
      event: { type: 'window.failed', status: 'failed', message, attempt: window.attempt },
    }, now())
    if (finished.event) events.publish(finished.event)
    return finished.record
  }

  return {
    async run(range, settings, repositories) {
      const window = await store.claim(range, repositories, now())
      if (!window) return store.load(range.id)
      const queued = window.events.at(-1)
      if (queued?.type === 'window.queued') events.publish(queued)
      await emit(window.id, { type: 'window.started', status: 'running', attempt: window.attempt })

      const repositoryRuns = await mapWithConcurrency(
        window.repositories,
        settings.windowSchedule.repositoryConcurrency,
        (repository) => processRepository(window, settings, repository),
      )
      try {
        await emit(window.id, { type: 'window.aggregate.started', status: 'running', attempt: window.attempt })
        const successes = repositoryRuns.filter((run) => run.status === 'succeeded')
        const status = successes.length === 0 ? 'failed' : successes.length === repositoryRuns.length ? 'published' : 'degraded'
        const aggregateInput = { ...window, status, repositoryRuns }
        let analysis = structuredWindowSummary(aggregateInput)
        let analysisError = null
        if (successes.length && await providerIsReady(settings)) {
          try {
            analysis = await aggregate(settings, aggregateInput)
          } catch (error) {
            analysisError = safeError(error)
          }
        }
        const report = { generatedAt: asDate(now()).toISOString(), analysis, analysisError }
        const artifact = await persistWindow(settings, aggregateInput, report)
        const nextRetryAt = status === 'failed' && window.attempt < settings.windowSchedule.maxAttempts ? retryAt(now(), window.attempt) : null
        const eventType = status === 'published' ? 'window.published' : status === 'degraded' ? 'window.degraded' : 'window.failed'
        const finished = await store.finish(window.id, {
          status,
          repositoryRuns,
          report,
          artifact,
          nextRetryAt,
          error: status === 'failed' ? repositoryRuns.map((run) => run.error).filter(Boolean).join('; ').slice(0, 600) : null,
          event: { type: eventType, status, attempt: window.attempt },
        }, now())
        if (finished.event) events.publish(finished.event)
        return finished.record
      } catch (error) {
        return finishWithFailure(window, settings, repositoryRuns, error)
      }
    },
  }
}
