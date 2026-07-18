import { randomUUID } from 'node:crypto'

import { buildDreamContext, buildScoutContext, collectDailyObservations, dreamScope, expandDreamEvidence } from './dream-context.js'
import { executeDreamScout, executeDreamSynthesis } from './dream-provider.js'
import { dreamIdempotencyKey } from './dream-schedule.js'
import { safeDreamError } from './dream-safety.js'

function runId() {
  return `run-${randomUUID()}`
}

function completeBoundary(windows, horizon) {
  return windows.find((window) => window.rangeEnd === horizon.end && window.publishTime === '00:00' && ['published', 'degraded'].includes(window.status)) || null
}

export function createDreamRunner({
  store,
  windowStore,
  now = () => new Date(),
  scout = executeDreamScout,
  synthesize = executeDreamSynthesis,
  expandEvidence = expandDreamEvidence,
}) {
  return {
    async run(horizon, settings, repositories) {
      const scope = dreamScope(settings)
      const claim = store.claim({
        id: runId(),
        scope,
        idempotencyKey: dreamIdempotencyKey(scope, horizon.end),
        horizon,
        leaseSeconds: settings.dreamSchedule.leaseSeconds,
      }, now())
      if (!claim.claimed) return claim.run
      const id = claim.run.id
      const leaseToken = claim.leaseToken
      let stage = 'inputs'
      try {
        const windows = await windowStore.list()
        const boundary = completeBoundary(windows, horizon)
        if (!boundary) {
          return store.finishBlocked(id, leaseToken, 'blocked_incomplete_sources', [`No durable 00:00 Window closes ${horizon.end}.`], now())
        }
        const knownState = store.knownState(scope)
        const observations = collectDailyObservations({ horizon, windows, repositories })
        if (!observations.windows.length) {
          return store.finishBlocked(id, leaseToken, 'blocked_incomplete_sources', ['No durable Window artifacts exist inside the daily horizon.'], now())
        }

        stage = 'scout'
        const scoutContext = buildScoutContext({ run: claim.run, state: claim.state, horizon, observations, knownState, limits: settings.dreamSchedule })
        store.saveStage(id, leaseToken, stage, { scout_context: scoutContext }, now())
        const scoutResult = await scout(settings, scoutContext)
        store.saveStage(id, leaseToken, 'evidence', { scout_output: scoutResult.scout, provider_model: scoutResult.model, usage: { scout: scoutResult.usage } }, now())
        if (scoutResult.scout.blocked_reason) {
          return store.finishBlocked(id, leaseToken, 'blocked_incomplete_sources', [scoutResult.scout.blocked_reason], now())
        }

        stage = 'evidence'
        const expandedEvidence = await expandEvidence({
          settings,
          requests: scoutResult.scout.evidence_requests,
          repositories,
          scoutContext,
          maxEvidenceRequests: settings.dreamSchedule.maxEvidenceRequests,
        })
        const prepared = buildDreamContext({
          run: claim.run,
          state: claim.state,
          horizon,
          observations,
          expandedEvidence,
          knownState,
          scout: scoutResult.scout,
          limits: settings.dreamSchedule,
          previousIssuedIds: scoutContext.issued_ids,
        })
        if (prepared.blocked) return store.finishBlocked(id, leaseToken, 'blocked_incomplete_sources', prepared.diagnostics, now())

        stage = 'synthesis'
        store.saveStage(id, leaseToken, stage, { context: prepared.context, context_hash: prepared.context.context_hash }, now())
        const synthesis = await synthesize(settings, prepared.context)
        store.saveStage(id, leaseToken, 'validated', { raw_output: synthesis.raw, provider_model: synthesis.model, usage: { scout: scoutResult.usage, synthesis: synthesis.usage } }, now())
        if (synthesis.batch.run.outcome === 'blocked_incomplete_sources') {
          return store.finishBlocked(id, leaseToken, synthesis.batch.run.outcome, [...prepared.diagnostics, synthesis.batch.run.notes], now())
        }

        stage = 'commit'
        return store.applyBatch({
          id,
          leaseToken,
          context: prepared.context,
          batch: synthesis.batch,
          evidence: prepared.context.evidence_catalog,
          providerModel: synthesis.model,
          usage: { scout: scoutResult.usage, synthesis: synthesis.usage, context: prepared.metrics },
        }, now()).run
      } catch (error) {
        const diagnostics = Array.isArray(error?.errors) ? error.errors.map((item) => safeDreamError(item, 800)) : []
        try {
          if (error?.rawOutput) {
            store.saveStage(id, leaseToken, stage, {
              raw_output: String(error.rawOutput).slice(0, 100_000),
              provider_model: error.providerModel,
              usage: error.providerUsage ? { failed_stage: error.providerUsage } : null,
            }, now())
          }
          return store.finishFailed(id, leaseToken, stage, safeDreamError(error), diagnostics, now())
        } catch {
          throw error
        }
      }
    },
  }
}
