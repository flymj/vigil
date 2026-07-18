import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import { requireDreamDatabaseSync } from './dream-compatibility.js'

const SCHEMA_VERSION = 1
const PROTOCOL_VERSION = '2.1'
const DETAIL_HISTORY_LIMIT = 200
const DETAIL_LINK_LIMIT = 100
const terminalStatuses = new Set(['accepted', 'blocked', 'failed'])

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function json(value) {
  return JSON.stringify(value ?? null)
}

function parse(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function transaction(database, operation) {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the original transaction failure.
    }
    throw error
  }
}

function migrate(database) {
  const current = Number(database.prepare('PRAGMA user_version').get().user_version)
  if (current > SCHEMA_VERSION) throw new Error(`Dream database schema ${current} is newer than supported schema ${SCHEMA_VERSION}`)
  if (current === SCHEMA_VERSION) return
  transaction(database, () => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS dream_state (
        scope TEXT PRIMARY KEY,
        cursor TEXT,
        signal_version INTEGER NOT NULL DEFAULT 0,
        topic_version INTEGER NOT NULL DEFAULT 0,
        evidence_version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dream_runs (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        protocol_version TEXT NOT NULL,
        horizon_start TEXT NOT NULL,
        horizon_end TEXT NOT NULL,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        lease_token TEXT,
        lease_expires_at TEXT,
        prepared_versions TEXT,
        scout_context TEXT,
        scout_output TEXT,
        context_json TEXT,
        context_hash TEXT,
        raw_output TEXT,
        batch_json TEXT,
        diagnostics TEXT,
        error TEXT,
        provider_model TEXT,
        usage_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS dream_runs_scope_horizon ON dream_runs(scope, horizon_end DESC);
      CREATE INDEX IF NOT EXISTS dream_runs_status ON dream_runs(status, lease_expires_at);

      CREATE TABLE IF NOT EXISTS dream_evidence (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        tier INTEGER NOT NULL,
        directness TEXT NOT NULL,
        repository TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        locator TEXT NOT NULL,
        claim TEXT NOT NULL,
        excerpt TEXT,
        content_hash TEXT NOT NULL,
        provenance_group TEXT NOT NULL,
        independence_group TEXT NOT NULL,
        canonical INTEGER NOT NULL,
        duplicate_of TEXT,
        truncated INTEGER NOT NULL DEFAULT 0,
        created_run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(created_run_id) REFERENCES dream_runs(id),
        FOREIGN KEY(duplicate_of) REFERENCES dream_evidence(id)
      );

      CREATE TABLE IF NOT EXISTS dream_signals (
        id TEXT PRIMARY KEY,
        current_revision_id TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        search_text TEXT NOT NULL,
        current_payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dream_signals_status ON dream_signals(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS dream_signal_fingerprints (
        fingerprint TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(signal_id) REFERENCES dream_signals(id)
      );

      CREATE TABLE IF NOT EXISTS dream_signal_revisions (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(signal_id, sequence),
        FOREIGN KEY(signal_id) REFERENCES dream_signals(id),
        FOREIGN KEY(run_id) REFERENCES dream_runs(id)
      );

      CREATE TABLE IF NOT EXISTS dream_forecasts (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        claim TEXT NOT NULL,
        due_at TEXT NOT NULL,
        expected_observations TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        FOREIGN KEY(signal_id) REFERENCES dream_signals(id),
        FOREIGN KEY(revision_id) REFERENCES dream_signal_revisions(id)
      );
      CREATE INDEX IF NOT EXISTS dream_forecasts_status_due ON dream_forecasts(status, due_at);

      CREATE TABLE IF NOT EXISTS dream_forecast_evaluations (
        id TEXT PRIMARY KEY,
        forecast_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        observed TEXT NOT NULL,
        evidence_ids TEXT NOT NULL,
        horizon_expired INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(forecast_id) REFERENCES dream_forecasts(id),
        FOREIGN KEY(run_id) REFERENCES dream_runs(id)
      );

      CREATE TABLE IF NOT EXISTS dream_topics (
        id TEXT PRIMARY KEY,
        current_revision_id TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        search_text TEXT NOT NULL,
        current_payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dream_topics_status ON dream_topics(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS dream_topic_fingerprints (
        fingerprint TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(topic_id) REFERENCES dream_topics(id)
      );

      CREATE TABLE IF NOT EXISTS dream_topic_revisions (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(topic_id, sequence),
        FOREIGN KEY(topic_id) REFERENCES dream_topics(id),
        FOREIGN KEY(run_id) REFERENCES dream_runs(id)
      );

      CREATE TABLE IF NOT EXISTS dream_topic_signal_links (
        topic_id TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        created_run_id TEXT NOT NULL,
        PRIMARY KEY(topic_id, signal_id),
        FOREIGN KEY(topic_id) REFERENCES dream_topics(id),
        FOREIGN KEY(signal_id) REFERENCES dream_signals(id),
        FOREIGN KEY(created_run_id) REFERENCES dream_runs(id)
      );

      CREATE TABLE IF NOT EXISTS dream_candidate_audits (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        title TEXT NOT NULL,
        disposition TEXT NOT NULL,
        reason TEXT NOT NULL,
        compared_signal_ids TEXT NOT NULL,
        compared_topic_ids TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES dream_runs(id)
      );
    `)
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  })
}

function runRecord(row, { includeAudit = false } = {}) {
  if (!row) return null
  const record = {
    id: row.id,
    scope: row.scope,
    idempotencyKey: row.idempotency_key,
    protocolVersion: row.protocol_version,
    horizon: { start: row.horizon_start, end: row.horizon_end, timezone: row.timezone },
    status: row.status,
    outcome: row.outcome,
    stage: row.stage,
    attempt: row.attempt,
    contextHash: row.context_hash,
    error: row.error,
    diagnostics: parse(row.diagnostics, []),
    providerModel: row.provider_model,
    usage: parse(row.usage_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
  if (includeAudit) {
    record.preparedVersions = parse(row.prepared_versions)
    record.scoutContext = parse(row.scout_context)
    record.scoutOutput = parse(row.scout_output)
    record.context = parse(row.context_json)
    record.rawOutput = row.raw_output
    record.batch = parse(row.batch_json)
  }
  return record
}

function publicEvidenceLocator(value) {
  const locator = String(value || '').trim().slice(0, 800)
  if (!locator || locator.startsWith('/') || locator.startsWith('file:') || locator.includes('..')) return null
  if (/^https?:\/\//i.test(locator) || /^(window|repository|review|commit|issue|release|change|patchset|diff|check|test|source-snapshot):/i.test(locator)) return locator
  return null
}

function evidenceRecord(row) {
  return {
    id: row.id,
    type: row.type,
    tier: row.tier,
    directness: row.directness,
    repository: row.repository,
    observedAt: row.observed_at,
    locator: publicEvidenceLocator(row.locator),
    claim: row.claim,
    canonical: Boolean(row.canonical),
    duplicateOf: row.duplicate_of,
    truncated: Boolean(row.truncated),
  }
}

function assertLease(run, leaseToken, timestamp) {
  if (!run) throw new Error('Dream run not found')
  if (run.status !== 'running') throw new Error('Dream run is not running')
  if (run.lease_token !== leaseToken) throw new Error('Dream run lease token mismatch')
  if (!run.lease_expires_at || run.lease_expires_at <= timestamp) throw new Error('Dream run lease expired')
}

function searchText(revision) {
  return [revision.title, revision.summary, revision.mechanism, revision.consequence, ...(revision.repositories || []), ...(revision.scope || [])]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
    .slice(0, 20_000)
}

function upsertFingerprints(database, table, entityColumn, entityId, previous, fingerprint, timestamp) {
  if (previous && previous !== fingerprint.current) {
    database.prepare(`UPDATE ${table} SET role = 'alias' WHERE fingerprint = ? AND ${entityColumn} = ?`).run(previous, entityId)
  }
  for (const value of [fingerprint.current, ...(fingerprint.aliases || [])]) {
    const owner = database.prepare(`SELECT ${entityColumn} AS id FROM ${table} WHERE fingerprint = ?`).get(value)
    if (owner && owner.id !== entityId) throw new Error(`Dream fingerprint ${value} is already owned by ${owner.id}`)
    database.prepare(`INSERT INTO ${table}(fingerprint, ${entityColumn}, role, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET role = excluded.role`).run(
      value,
      entityId,
      value === fingerprint.current ? 'current' : 'alias',
      timestamp,
    )
  }
}

function applySignalChange(database, runId, change, timestamp) {
  const revision = change.revision
  const existing = database.prepare('SELECT * FROM dream_signals WHERE id = ?').get(change.signal_id)
  if (change.change_type === 'create' && existing) throw new Error(`Signal ${change.signal_id} already exists`)
  if (change.change_type !== 'create' && !existing) throw new Error(`Signal ${change.signal_id} does not exist`)
  const sequence = Number(database.prepare('SELECT COUNT(*) AS count FROM dream_signal_revisions WHERE signal_id = ?').get(change.signal_id).count) + 1
  if (!existing) {
    database.prepare(`INSERT INTO dream_signals(id, current_revision_id, status, title, fingerprint, search_text, current_payload, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(change.signal_id, revision.id, revision.status, revision.title, revision.fingerprint.current, searchText(revision), json(revision), timestamp, timestamp)
  } else {
    database.prepare(`UPDATE dream_signals SET current_revision_id = ?, status = ?, title = ?, fingerprint = ?, search_text = ?, current_payload = ?, updated_at = ? WHERE id = ?`)
      .run(revision.id, revision.status, revision.title, revision.fingerprint.current, searchText(revision), json(revision), timestamp, change.signal_id)
  }
  upsertFingerprints(database, 'dream_signal_fingerprints', 'signal_id', change.signal_id, existing?.fingerprint, revision.fingerprint, timestamp)
  database.prepare('INSERT INTO dream_signal_revisions(id, signal_id, sequence, run_id, payload, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(revision.id, change.signal_id, sequence, runId, json(revision), timestamp)

  for (const evaluation of revision.forecast_evaluations || []) {
    const forecast = database.prepare('SELECT * FROM dream_forecasts WHERE id = ?').get(evaluation.forecast_id)
    if (!forecast || forecast.status !== 'open') throw new Error(`Forecast ${evaluation.forecast_id} is not open`)
    database.prepare(`INSERT INTO dream_forecast_evaluations(id, forecast_id, run_id, outcome, observed, evidence_ids, horizon_expired, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(evaluation.id, evaluation.forecast_id, runId, evaluation.outcome, evaluation.observed, json(evaluation.evidence_ids), evaluation.horizon_expired ? 1 : 0, timestamp)
    database.prepare('UPDATE dream_forecasts SET status = ? WHERE id = ?').run(evaluation.outcome, evaluation.forecast_id)
  }
  for (const forecast of revision.forecasts || []) {
    database.prepare(`INSERT INTO dream_forecasts(id, signal_id, revision_id, claim, due_at, expected_observations, status, created_at)
      VALUES(?, ?, ?, ?, ?, ?, 'open', ?)`).run(forecast.id, change.signal_id, revision.id, forecast.claim, forecast.due_at, json(forecast.expected_observations), timestamp)
  }
}

function applyTopicChange(database, runId, change, timestamp) {
  const revision = change.revision
  const existing = database.prepare('SELECT * FROM dream_topics WHERE id = ?').get(change.topic_id)
  if (change.change_type === 'create' && existing) throw new Error(`Topic ${change.topic_id} already exists`)
  if (change.change_type !== 'create' && !existing) throw new Error(`Topic ${change.topic_id} does not exist`)
  const sequence = Number(database.prepare('SELECT COUNT(*) AS count FROM dream_topic_revisions WHERE topic_id = ?').get(change.topic_id).count) + 1
  if (!existing) {
    database.prepare(`INSERT INTO dream_topics(id, current_revision_id, status, title, fingerprint, search_text, current_payload, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(change.topic_id, revision.id, revision.status, revision.title, revision.fingerprint.current, searchText(revision), json(revision), timestamp, timestamp)
  } else {
    database.prepare(`UPDATE dream_topics SET current_revision_id = ?, status = ?, title = ?, fingerprint = ?, search_text = ?, current_payload = ?, updated_at = ? WHERE id = ?`)
      .run(revision.id, revision.status, revision.title, revision.fingerprint.current, searchText(revision), json(revision), timestamp, change.topic_id)
  }
  upsertFingerprints(database, 'dream_topic_fingerprints', 'topic_id', change.topic_id, existing?.fingerprint, revision.fingerprint, timestamp)
  database.prepare('INSERT INTO dream_topic_revisions(id, topic_id, sequence, run_id, payload, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(revision.id, change.topic_id, sequence, runId, json(revision), timestamp)
  database.prepare('DELETE FROM dream_topic_signal_links WHERE topic_id = ?').run(change.topic_id)
  for (const signalId of revision.signal_ids || []) {
    database.prepare('INSERT INTO dream_topic_signal_links(topic_id, signal_id, created_run_id) VALUES(?, ?, ?)').run(change.topic_id, signalId, runId)
  }
}

function publicSignal(database, row) {
  const revision = parse(row.current_payload, {})
  const forecastCounts = database.prepare(`SELECT
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status != 'open' THEN 1 ELSE 0 END) AS evaluated_count
    FROM dream_forecasts WHERE signal_id = ?`).get(row.id)
  const topicCount = database.prepare('SELECT COUNT(*) AS count FROM dream_topic_signal_links WHERE signal_id = ?').get(row.id)
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    fingerprint: row.fingerprint,
    summary: revision.summary,
    direction: revision.direction,
    importance: revision.importance,
    confidence: revision.confidence,
    repositories: revision.repositories || [],
    evidenceCount: (revision.evidence_ids || []).length,
    openForecastCount: Number(forecastCounts.open_count || 0),
    evaluatedForecastCount: Number(forecastCounts.evaluated_count || 0),
    topicCount: Number(topicCount.count || 0),
    updatedAt: row.updated_at,
  }
}

function publicTopic(database, row) {
  const revision = parse(row.current_payload, {})
  const signalCount = database.prepare('SELECT COUNT(*) AS count FROM dream_topic_signal_links WHERE topic_id = ?').get(row.id)
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    fingerprint: row.fingerprint,
    summary: revision.summary,
    thesis: revision.thesis,
    scope: revision.scope || [],
    evidenceCount: (revision.evidence_ids || []).length,
    signalCount: Number(signalCount.count || 0),
    updatedAt: row.updated_at,
  }
}

export function dreamDatabasePath(settings) {
  return path.join(settings.workspace.directory, 'dream.sqlite3')
}

export function createDreamStore(settings, options = {}) {
  const DatabaseSync = requireDreamDatabaseSync()
  const target = options.databasePath || dreamDatabasePath(settings)
  if (target !== ':memory:') mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(target, { timeout: options.timeoutMs || 5_000 })
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA busy_timeout = 5000')
  if (target !== ':memory:') {
    database.exec('PRAGMA journal_mode = WAL')
    try { chmodSync(target, 0o600) } catch { /* Best effort on non-POSIX filesystems. */ }
  }
  migrate(database)

  function ensureState(scope, timestamp = iso(options.now?.() || new Date())) {
    database.prepare(`INSERT INTO dream_state(scope, cursor, signal_version, topic_version, evidence_version, updated_at)
      VALUES(?, NULL, 0, 0, 0, ?) ON CONFLICT(scope) DO NOTHING`).run(scope, timestamp)
    return database.prepare('SELECT * FROM dream_state WHERE scope = ?').get(scope)
  }

  return {
    database,
    close() { database.close() },
    state(scope) {
      const row = ensureState(scope)
      return { scope: row.scope, cursor: row.cursor, versions: { signals: row.signal_version, topics: row.topic_version, evidence: row.evidence_version }, updatedAt: row.updated_at }
    },
    claim({ id, scope, idempotencyKey, horizon, leaseSeconds = 900 }, now = new Date()) {
      const timestamp = iso(now)
      const leaseToken = randomUUID()
      const leaseExpiresAt = new Date(new Date(timestamp).getTime() + boundedInteger(leaseSeconds, 900, 30, 7200) * 1000).toISOString()
      return transaction(database, () => {
        const state = ensureState(scope, timestamp)
        const existing = database.prepare('SELECT * FROM dream_runs WHERE idempotency_key = ?').get(idempotencyKey)
        if (existing?.status === 'accepted') return { claimed: false, run: runRecord(existing), state: this.state(scope) }
        if (existing?.status === 'running' && existing.lease_expires_at > timestamp) return { claimed: false, run: runRecord(existing), state: this.state(scope) }
        if (!existing) {
          database.prepare(`INSERT INTO dream_runs(id, scope, idempotency_key, protocol_version, horizon_start, horizon_end, timezone, status, stage, attempt, lease_token, lease_expires_at, prepared_versions, created_at, started_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, 'running', 'claimed', 1, ?, ?, ?, ?, ?)`).run(id, scope, idempotencyKey, PROTOCOL_VERSION, horizon.start, horizon.end, horizon.timezone, leaseToken, leaseExpiresAt, json({ signals: state.signal_version, topics: state.topic_version, evidence: state.evidence_version }), timestamp, timestamp)
        } else {
          database.prepare(`UPDATE dream_runs SET status = 'running', stage = 'claimed', attempt = attempt + 1, lease_token = ?, lease_expires_at = ?, prepared_versions = ?, started_at = ?, finished_at = NULL, outcome = NULL, error = NULL, diagnostics = NULL WHERE id = ?`)
            .run(leaseToken, leaseExpiresAt, json({ signals: state.signal_version, topics: state.topic_version, evidence: state.evidence_version }), timestamp, existing.id)
        }
        const row = database.prepare('SELECT * FROM dream_runs WHERE idempotency_key = ?').get(idempotencyKey)
        return { claimed: true, leaseToken, run: runRecord(row), state: this.state(scope) }
      })
    },
    saveStage(id, leaseToken, stage, payload = {}, now = new Date()) {
      const timestamp = iso(now)
      const run = database.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id)
      assertLease(run, leaseToken, timestamp)
      const columns = {
        scout_context: 'scout_context',
        scout_output: 'scout_output',
        context: 'context_json',
        raw_output: 'raw_output',
      }
      const updates = ['stage = ?']
      const values = [stage]
      for (const [name, column] of Object.entries(columns)) {
        if (!(name in payload)) continue
        updates.push(`${column} = ?`)
        values.push(name === 'raw_output' ? String(payload[name] ?? '') : json(payload[name]))
      }
      if (payload.context_hash) { updates.push('context_hash = ?'); values.push(payload.context_hash) }
      if (payload.provider_model) { updates.push('provider_model = ?'); values.push(payload.provider_model) }
      if (payload.usage) { updates.push('usage_json = ?'); values.push(json(payload.usage)) }
      values.push(id)
      database.prepare(`UPDATE dream_runs SET ${updates.join(', ')} WHERE id = ?`).run(...values)
      return runRecord(database.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id))
    },
    finishBlocked(id, leaseToken, outcome, diagnostics = [], now = new Date()) {
      const timestamp = iso(now)
      const run = database.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id)
      assertLease(run, leaseToken, timestamp)
      database.prepare(`UPDATE dream_runs SET status = 'blocked', outcome = ?, stage = 'blocked', diagnostics = ?, lease_token = NULL, lease_expires_at = NULL, finished_at = ? WHERE id = ?`)
        .run(outcome || 'blocked_incomplete_sources', json(diagnostics), timestamp, id)
      return runRecord(database.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id))
    },
    finishFailed(id, leaseToken, stage, error, diagnostics = [], now = new Date()) {
      const timestamp = iso(now)
      const run = database.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id)
      assertLease(run, leaseToken, timestamp)
      database.prepare(`UPDATE dream_runs SET status = 'failed', stage = ?, error = ?, diagnostics = ?, lease_token = NULL, lease_expires_at = NULL, finished_at = ? WHERE id = ?`)
        .run(stage, String(error || 'Unknown Dream failure').slice(0, 1200), json(diagnostics), timestamp, id)
      return runRecord(database.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id))
    },
    applyBatch({ id, leaseToken, context, batch, evidence = context.evidence_catalog || [], providerModel = null, usage = null }, now = new Date()) {
      const timestamp = iso(now)
      return transaction(database, () => {
        const run = database.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id)
        assertLease(run, leaseToken, timestamp)
        const state = ensureState(run.scope, timestamp)
        const expected = context.run.known_state
        if (state.cursor !== context.run.cursor_before || state.signal_version !== expected.signals || state.topic_version !== expected.topics || state.evidence_version !== expected.evidence) {
          throw new Error('Dream ledger versions or cursor changed after context preparation')
        }
        if (run.context_hash !== context.context_hash || batch.run.context_hash !== context.context_hash) throw new Error('Dream context hash changed before commit')

        let evidenceChanges = 0
        for (const item of evidence) {
          const existing = database.prepare('SELECT id, source_key FROM dream_evidence WHERE id = ? OR source_key = ?').get(item.id, item.source_key)
          if (existing && (existing.id !== item.id || existing.source_key !== item.source_key)) throw new Error(`Evidence identity collision for ${item.id}`)
          if (existing) continue
          database.prepare(`INSERT INTO dream_evidence(id, source_key, type, tier, directness, repository, observed_at, locator, claim, excerpt, content_hash, provenance_group, independence_group, canonical, duplicate_of, truncated, created_run_id, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.id, item.source_key, item.type, item.tier, item.directness, item.repository, item.observed_at, item.locator, item.claim, item.excerpt || null, item.content_hash, item.provenance_group, item.independence_group, item.canonical ? 1 : 0, item.duplicate_of || null, item.truncated ? 1 : 0, id, timestamp)
          evidenceChanges += 1
        }

        for (const candidate of batch.run.candidates || []) {
          database.prepare(`INSERT INTO dream_candidate_audits(id, run_id, title, disposition, reason, compared_signal_ids, compared_topic_ids)
            VALUES(?, ?, ?, ?, ?, ?, ?)`).run(candidate.id, id, candidate.title, candidate.disposition, candidate.reason, json(candidate.compared_signal_ids), json(candidate.compared_topic_ids))
        }
        for (const change of batch.signal_changes || []) applySignalChange(database, id, change, timestamp)
        for (const change of batch.topic_changes || []) applyTopicChange(database, id, change, timestamp)

        const signalChanges = (batch.signal_changes || []).length
        const topicChanges = (batch.topic_changes || []).length
        const cursor = batch.run.cursor.advance_on_publish ? batch.run.cursor.candidate_after : state.cursor
        database.prepare(`UPDATE dream_state SET cursor = ?, signal_version = signal_version + ?, topic_version = topic_version + ?, evidence_version = evidence_version + ?, updated_at = ? WHERE scope = ?`)
          .run(cursor, signalChanges ? 1 : 0, topicChanges ? 1 : 0, evidenceChanges ? 1 : 0, timestamp, run.scope)
        database.prepare(`UPDATE dream_runs SET status = 'accepted', outcome = ?, stage = 'committed', batch_json = ?, provider_model = ?, usage_json = ?, lease_token = NULL, lease_expires_at = NULL, finished_at = ? WHERE id = ?`)
          .run(batch.run.outcome, json(batch), providerModel, usage ? json(usage) : null, timestamp, id)
        return { run: runRecord(database.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id)), state: this.state(run.scope) }
      })
    },
    knownState(scope) {
      const state = this.state(scope)
      const signals = database.prepare('SELECT * FROM dream_signals ORDER BY updated_at DESC').all().map((row) => ({ ...parse(row.current_payload, {}), id: row.id, status: row.status, title: row.title, fingerprint: { current: row.fingerprint, aliases: database.prepare("SELECT fingerprint FROM dream_signal_fingerprints WHERE signal_id = ? AND role = 'alias' ORDER BY created_at").all(row.id).map((item) => item.fingerprint) } }))
      const topics = database.prepare('SELECT * FROM dream_topics ORDER BY updated_at DESC').all().map((row) => ({ ...parse(row.current_payload, {}), id: row.id, status: row.status, title: row.title, fingerprint: { current: row.fingerprint, aliases: database.prepare("SELECT fingerprint FROM dream_topic_fingerprints WHERE topic_id = ? AND role = 'alias' ORDER BY created_at").all(row.id).map((item) => item.fingerprint) } }))
      const forecasts = database.prepare('SELECT * FROM dream_forecasts WHERE status = ? ORDER BY due_at').all('open').map((row) => ({ id: row.id, signal_id: row.signal_id, claim: row.claim, due_at: row.due_at, expected_observations: parse(row.expected_observations, []), status: row.status }))
      return { state, signals, topics, forecasts }
    },
    listSignals({ query = '', status = '', limit = 50, offset = 0 } = {}) {
      const safeLimit = boundedInteger(limit, 50, 1, 100)
      const safeOffset = boundedInteger(offset, 0, 0, 100_000)
      const clauses = []
      const values = []
      if (query) { clauses.push('search_text LIKE ?'); values.push(`%${String(query).toLocaleLowerCase().slice(0, 120)}%`) }
      if (status) { clauses.push('status = ?'); values.push(String(status).slice(0, 40)) }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM dream_signals ${where}`).get(...values).count)
      const rows = database.prepare(`SELECT * FROM dream_signals ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...values, safeLimit, safeOffset)
      return { items: rows.map((row) => publicSignal(database, row)), total, limit: safeLimit, offset: safeOffset }
    },
    getSignal(id) {
      const row = database.prepare('SELECT * FROM dream_signals WHERE id = ?').get(id)
      if (!row) return null
      const current = parse(row.current_payload, {})
      const revisionRows = database.prepare('SELECT * FROM dream_signal_revisions WHERE signal_id = ? ORDER BY sequence DESC LIMIT ?').all(id, DETAIL_HISTORY_LIMIT + 1)
      const forecastRows = database.prepare('SELECT * FROM dream_forecasts WHERE signal_id = ? ORDER BY created_at DESC LIMIT ?').all(id, DETAIL_HISTORY_LIMIT + 1)
      const topicRows = database.prepare('SELECT t.* FROM dream_topics t JOIN dream_topic_signal_links l ON l.topic_id = t.id WHERE l.signal_id = ? ORDER BY t.updated_at DESC LIMIT ?').all(id, DETAIL_LINK_LIMIT + 1)
      const revisions = revisionRows.slice(0, DETAIL_HISTORY_LIMIT).map((item) => ({ id: item.id, sequence: item.sequence, runId: item.run_id, createdAt: item.created_at, ...parse(item.payload, {}) }))
      const forecasts = forecastRows.slice(0, DETAIL_HISTORY_LIMIT).map((item) => ({ id: item.id, claim: item.claim, dueAt: item.due_at, expectedObservations: parse(item.expected_observations, []), status: item.status, evaluation: (() => { const evaluation = database.prepare('SELECT * FROM dream_forecast_evaluations WHERE forecast_id = ?').get(item.id); return evaluation ? { id: evaluation.id, outcome: evaluation.outcome, observed: evaluation.observed, evidenceIds: parse(evaluation.evidence_ids, []), horizonExpired: Boolean(evaluation.horizon_expired), createdAt: evaluation.created_at } : null })() }))
      const topics = topicRows.slice(0, DETAIL_LINK_LIMIT).map((item) => publicTopic(database, item))
      const evidenceIds = [...new Set(revisions.flatMap((revision) => revision.evidence_ids || []))]
      const evidence = evidenceIds.map((evidenceId) => database.prepare('SELECT * FROM dream_evidence WHERE id = ?').get(evidenceId)).filter(Boolean).map(evidenceRecord)
      return {
        ...publicSignal(database, row),
        current,
        revisions,
        forecasts,
        topics,
        evidence,
        detailLimits: {
          revisions: DETAIL_HISTORY_LIMIT,
          forecasts: DETAIL_HISTORY_LIMIT,
          links: DETAIL_LINK_LIMIT,
          truncated: {
            revisions: revisionRows.length > DETAIL_HISTORY_LIMIT,
            forecasts: forecastRows.length > DETAIL_HISTORY_LIMIT,
            links: topicRows.length > DETAIL_LINK_LIMIT,
          },
        },
      }
    },
    listSignalRevisions(id, { limit = 50, offset = 0 } = {}) {
      if (!database.prepare('SELECT 1 FROM dream_signals WHERE id = ?').get(id)) return null
      const safeLimit = boundedInteger(limit, 50, 1, 100)
      const safeOffset = boundedInteger(offset, 0, 0, 100_000)
      const total = Number(database.prepare('SELECT COUNT(*) AS count FROM dream_signal_revisions WHERE signal_id = ?').get(id).count)
      const rows = database.prepare('SELECT * FROM dream_signal_revisions WHERE signal_id = ? ORDER BY sequence DESC LIMIT ? OFFSET ?').all(id, safeLimit, safeOffset)
      return { items: rows.map((item) => ({ id: item.id, sequence: item.sequence, runId: item.run_id, createdAt: item.created_at, ...parse(item.payload, {}) })), total, limit: safeLimit, offset: safeOffset }
    },
    listSignalForecasts(id, { limit = 50, offset = 0 } = {}) {
      if (!database.prepare('SELECT 1 FROM dream_signals WHERE id = ?').get(id)) return null
      const safeLimit = boundedInteger(limit, 50, 1, 100)
      const safeOffset = boundedInteger(offset, 0, 0, 100_000)
      const total = Number(database.prepare('SELECT COUNT(*) AS count FROM dream_forecasts WHERE signal_id = ?').get(id).count)
      const rows = database.prepare('SELECT * FROM dream_forecasts WHERE signal_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(id, safeLimit, safeOffset)
      const items = rows.map((item) => {
        const evaluation = database.prepare('SELECT * FROM dream_forecast_evaluations WHERE forecast_id = ?').get(item.id)
        return {
          id: item.id,
          claim: item.claim,
          dueAt: item.due_at,
          expectedObservations: parse(item.expected_observations, []),
          status: item.status,
          evaluation: evaluation ? { id: evaluation.id, outcome: evaluation.outcome, observed: evaluation.observed, evidenceIds: parse(evaluation.evidence_ids, []), horizonExpired: Boolean(evaluation.horizon_expired), createdAt: evaluation.created_at } : null,
        }
      })
      return { items, total, limit: safeLimit, offset: safeOffset }
    },
    listTopics({ query = '', status = '', limit = 50, offset = 0 } = {}) {
      const safeLimit = boundedInteger(limit, 50, 1, 100)
      const safeOffset = boundedInteger(offset, 0, 0, 100_000)
      const clauses = []
      const values = []
      if (query) { clauses.push('search_text LIKE ?'); values.push(`%${String(query).toLocaleLowerCase().slice(0, 120)}%`) }
      if (status) { clauses.push('status = ?'); values.push(String(status).slice(0, 40)) }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM dream_topics ${where}`).get(...values).count)
      const rows = database.prepare(`SELECT * FROM dream_topics ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...values, safeLimit, safeOffset)
      return { items: rows.map((row) => publicTopic(database, row)), total, limit: safeLimit, offset: safeOffset }
    },
    getTopic(id) {
      const row = database.prepare('SELECT * FROM dream_topics WHERE id = ?').get(id)
      if (!row) return null
      const current = parse(row.current_payload, {})
      const revisionRows = database.prepare('SELECT * FROM dream_topic_revisions WHERE topic_id = ? ORDER BY sequence DESC LIMIT ?').all(id, DETAIL_HISTORY_LIMIT + 1)
      const signalRows = database.prepare('SELECT s.* FROM dream_signals s JOIN dream_topic_signal_links l ON l.signal_id = s.id WHERE l.topic_id = ? ORDER BY s.updated_at DESC LIMIT ?').all(id, DETAIL_LINK_LIMIT + 1)
      const revisions = revisionRows.slice(0, DETAIL_HISTORY_LIMIT).map((item) => ({ id: item.id, sequence: item.sequence, runId: item.run_id, createdAt: item.created_at, ...parse(item.payload, {}) }))
      const signals = signalRows.slice(0, DETAIL_LINK_LIMIT).map((item) => publicSignal(database, item))
      const evidenceIds = [...new Set(revisions.flatMap((revision) => revision.evidence_ids || []))]
      const evidence = evidenceIds.map((evidenceId) => database.prepare('SELECT * FROM dream_evidence WHERE id = ?').get(evidenceId)).filter(Boolean).map(evidenceRecord)
      return {
        ...publicTopic(database, row),
        current,
        revisions,
        signals,
        evidence,
        detailLimits: {
          revisions: DETAIL_HISTORY_LIMIT,
          links: DETAIL_LINK_LIMIT,
          truncated: {
            revisions: revisionRows.length > DETAIL_HISTORY_LIMIT,
            links: signalRows.length > DETAIL_LINK_LIMIT,
          },
        },
      }
    },
    listTopicRevisions(id, { limit = 50, offset = 0 } = {}) {
      if (!database.prepare('SELECT 1 FROM dream_topics WHERE id = ?').get(id)) return null
      const safeLimit = boundedInteger(limit, 50, 1, 100)
      const safeOffset = boundedInteger(offset, 0, 0, 100_000)
      const total = Number(database.prepare('SELECT COUNT(*) AS count FROM dream_topic_revisions WHERE topic_id = ?').get(id).count)
      const rows = database.prepare('SELECT * FROM dream_topic_revisions WHERE topic_id = ? ORDER BY sequence DESC LIMIT ? OFFSET ?').all(id, safeLimit, safeOffset)
      return { items: rows.map((item) => ({ id: item.id, sequence: item.sequence, runId: item.run_id, createdAt: item.created_at, ...parse(item.payload, {}) })), total, limit: safeLimit, offset: safeOffset }
    },
    listTopicSignals(id, { limit = 50, offset = 0 } = {}) {
      if (!database.prepare('SELECT 1 FROM dream_topics WHERE id = ?').get(id)) return null
      const safeLimit = boundedInteger(limit, 50, 1, 100)
      const safeOffset = boundedInteger(offset, 0, 0, 100_000)
      const total = Number(database.prepare('SELECT COUNT(*) AS count FROM dream_topic_signal_links WHERE topic_id = ?').get(id).count)
      const rows = database.prepare('SELECT s.* FROM dream_signals s JOIN dream_topic_signal_links l ON l.signal_id = s.id WHERE l.topic_id = ? ORDER BY s.updated_at DESC LIMIT ? OFFSET ?').all(id, safeLimit, safeOffset)
      return { items: rows.map((item) => publicSignal(database, item)), total, limit: safeLimit, offset: safeOffset }
    },
    listRuns({ scope = '', status = '', limit = 50, offset = 0 } = {}) {
      const safeLimit = boundedInteger(limit, 50, 1, 100)
      const safeOffset = boundedInteger(offset, 0, 0, 100_000)
      const clauses = []
      const values = []
      if (scope) { clauses.push('scope = ?'); values.push(scope) }
      if (status) { clauses.push('status = ?'); values.push(status) }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM dream_runs ${where}`).get(...values).count)
      const rows = database.prepare(`SELECT * FROM dream_runs ${where} ORDER BY horizon_end DESC, created_at DESC LIMIT ? OFFSET ?`).all(...values, safeLimit, safeOffset)
      return { items: rows.map((row) => runRecord(row)), total, limit: safeLimit, offset: safeOffset }
    },
    getRun(id, options = {}) {
      return runRecord(database.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id), options)
    },
    retryable(id) {
      const row = database.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id)
      return Boolean(row && terminalStatuses.has(row.status) && row.status !== 'accepted')
    },
    status(scope) {
      const state = this.state(scope)
      const current = database.prepare("SELECT * FROM dream_runs WHERE scope = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1").get(scope)
      const last = database.prepare("SELECT * FROM dream_runs WHERE scope = ? AND status IN ('accepted', 'blocked', 'failed') ORDER BY horizon_end DESC, finished_at DESC LIMIT 1").get(scope)
      return { state, currentRun: runRecord(current), lastRun: runRecord(last) }
    },
  }
}
