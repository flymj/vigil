import { randomUUID } from 'node:crypto'

import { snoopChange } from './repository-intelligence.js'
import { boundedText, canonicalJson, contextHash, evidenceId, sanitizeDreamLocator, sanitizeDreamText, sha256 } from './dream-safety.js'

const evidenceShape = {
  commit: { tier: 1, directness: 'direct' },
  diff: { tier: 1, directness: 'direct' },
  test: { tier: 1, directness: 'direct' },
  benchmark: { tier: 1, directness: 'direct' },
  code_review: { tier: 2, directness: 'intent' },
  issue: { tier: 2, directness: 'intent' },
  design_document: { tier: 2, directness: 'intent' },
  release: { tier: 2, directness: 'intent' },
  window_summary: { tier: 3, directness: 'derived' },
  repository_summary: { tier: 3, directness: 'derived' },
}

function prefixedId(prefix) {
  return `${prefix}-${randomUUID()}`
}

function repositoryLabel(repository) {
  return `${repository.project || repository.name || repository.id}@${repository.branch || repository.defaultBranch || 'main'}`
}

function sourcePrefix(repository) {
  const provider = repository.sourceType === 'gerrit' ? 'gerrit' : 'github'
  return `${provider}:${repository.host || (provider === 'github' ? 'github.com' : 'unknown')}/${repository.project || repository.name || repository.id}`
}

function evidenceRecord({ sourceKey, type, repository, observedAt, locator, claim, excerpt, provenanceGroup, independenceGroup, canonical = true, duplicateOf = null, truncated = false }) {
  const shape = evidenceShape[type]
  if (!shape) throw new Error(`Unsupported Dream evidence type ${type}`)
  const bounded = boundedText(excerpt || claim, 6_000)
  return {
    id: evidenceId(sourceKey),
    source_key: sourceKey,
    type,
    tier: shape.tier,
    directness: shape.directness,
    repository: sanitizeDreamText(repository, 500),
    observed_at: new Date(observedAt).toISOString(),
    locator: sanitizeDreamLocator(locator),
    claim: sanitizeDreamText(claim, 1_200),
    excerpt: bounded.text,
    content_hash: sha256(String(excerpt || claim || '')),
    provenance_group: sanitizeDreamText(provenanceGroup || sourceKey, 500),
    independence_group: sanitizeDreamText(independenceGroup || provenanceGroup || sourceKey, 500),
    canonical: Boolean(canonical),
    duplicate_of: duplicateOf,
    truncated: Boolean(truncated || bounded.truncated),
  }
}

function addEvidence(map, item) {
  const existing = map.get(item.id)
  if (existing && existing.source_key !== item.source_key) throw new Error(`Dream evidence collision for ${item.id}`)
  if (!existing) map.set(item.id, item)
}

function safeAnalysisContent(value) {
  return boundedText(value || '', 12_000).text
}

function manifestItem(id, type, repository, ref, payload, range = null) {
  return {
    id,
    type,
    repository,
    ref,
    content_hash: sha256(payload),
    ...(range ? { window: { start: range.start, end: range.end } } : {}),
  }
}

function repoForRun(run, repositories) {
  return repositories.find((repository) => repository.id === run.repositoryId)
    || repositories.find((repository) => (repository.project || repository.name) === String(run.snapshot?.repository || run.repository || '').split('@')[0])
    || {
      id: run.repositoryId || run.repository,
      sourceType: run.snapshot?.sourceType || 'github',
      host: run.snapshot?.sourceType === 'gerrit' ? 'unknown' : 'github.com',
      project: String(run.snapshot?.repository || run.repository || run.repositoryId).split('@')[0],
      branch: run.snapshot?.branch || 'main',
    }
}

function compactSignal(signal) {
  return {
    id: signal.id,
    title: sanitizeDreamText(signal.title, 240),
    status: signal.status,
    fingerprint: signal.fingerprint,
    repositories: signal.repositories || [],
    summary: sanitizeDreamText(signal.summary, 700),
    mechanism: sanitizeDreamText(signal.mechanism, 700),
    direction: signal.direction,
    confidence: signal.confidence,
    importance: signal.importance,
  }
}

function compactTopic(topic) {
  return {
    id: topic.id,
    title: sanitizeDreamText(topic.title, 240),
    status: topic.status,
    fingerprint: topic.fingerprint,
    summary: sanitizeDreamText(topic.summary, 700),
    thesis: sanitizeDreamText(topic.thesis, 900),
    signal_ids: topic.signal_ids || [],
  }
}

function typedIds(limits, previous = null) {
  if (previous) return previous
  const create = (prefix, count) => Array.from({ length: count }, () => prefixedId(prefix))
  return {
    candidates: create('cand', limits.maxCandidates),
    signals: create('sig', limits.maxSignalChanges),
    signal_changes: create('schg', limits.maxSignalChanges),
    signal_revisions: create('srev', limits.maxSignalChanges),
    topics: create('top', limits.maxTopicChanges),
    topic_changes: create('tchg', limits.maxTopicChanges),
    topic_revisions: create('trev', limits.maxTopicChanges),
    forecasts: create('fc', limits.maxSignalChanges * 2),
    forecast_evaluations: create('fce', Math.max(limits.maxSignalChanges * 3, 3)),
    suppression_groups: create('sg', Math.max(limits.maxCandidates * 2, 2)),
  }
}

export function dreamScope(settings) {
  return `workspace:${sha256(String(settings.workspace.directory)).slice(0, 16)}`
}

export function collectDailyObservations({ horizon, windows, repositories }) {
  const evidence = new Map()
  const manifest = []
  const allowedRequests = []
  const diagnostics = []
  const selected = [...windows]
    .filter((window) => window.rangeStart >= horizon.start && window.rangeEnd <= horizon.end)
    .sort((left, right) => left.rangeEnd.localeCompare(right.rangeEnd))

  for (const window of selected) {
    const windowPayload = {
      id: window.id,
      rangeStart: window.rangeStart,
      rangeEnd: window.rangeEnd,
      status: window.status,
      report: window.report?.analysis?.content || '',
      repositories: (window.repositoryRuns || []).map((run) => ({ repositoryId: run.repositoryId, status: run.status, counts: run.counts || null, artifactId: run.artifactId || null })),
    }
    manifest.push(manifestItem(`window:${window.id}`, 'window_summary', '*', window.id, windowPayload, { start: window.rangeStart, end: window.rangeEnd }))
    const windowSource = `window:${window.id}`
    addEvidence(evidence, evidenceRecord({
      sourceKey: windowSource,
      type: 'window_summary',
      repository: '*',
      observedAt: window.rangeEnd,
      locator: `window:${window.id}`,
      claim: `Window ${window.rangeStart} to ${window.rangeEnd} completed with status ${window.status}.`,
      excerpt: safeAnalysisContent(window.report?.analysis?.content),
      provenanceGroup: windowSource,
      independenceGroup: windowSource,
    }))
    if (window.status === 'degraded') diagnostics.push(`Window ${window.id} is degraded; missing repository inputs remain explicit.`)

    for (const run of window.repositoryRuns || []) {
      const repository = repoForRun(run, repositories)
      const repositoryName = repositoryLabel(repository)
      if (run.status !== 'succeeded' || !run.snapshot) {
        diagnostics.push(`${repositoryName}: repository observation failed in Window ${window.id}.`)
        continue
      }
      const snapshot = run.snapshot
      const prefix = sourcePrefix(repository)
      const reportRef = run.artifactId || `${window.id}:${repository.id}`
      const reportSource = `${prefix}:repository-summary:${reportRef}`
      const reportPayload = { snapshot, analysis: run.report?.analysis || null }
      manifest.push(manifestItem(`repository:${window.id}:${repository.id}`, 'repository_summary', repositoryName, reportRef, reportPayload, { start: window.rangeStart, end: window.rangeEnd }))
      addEvidence(evidence, evidenceRecord({
        sourceKey: reportSource,
        type: 'repository_summary',
        repository: repositoryName,
        observedAt: window.rangeEnd,
        locator: `repository-summary:${reportRef}`,
        claim: `The repository summary covers ${snapshot.counts?.commits || 0} commits and ${snapshot.counts?.pullRequests || 0} active reviews.`,
        excerpt: safeAnalysisContent(run.report?.analysis?.content),
        provenanceGroup: reportSource,
        independenceGroup: `${prefix}:window:${window.id}`,
      }))

      for (const commit of snapshot.commits || []) {
        const sha = commit.fullSha || commit.sha
        if (!sha) continue
        const sourceKey = `${prefix}:commit:${sha}`
        addEvidence(evidence, evidenceRecord({
          sourceKey,
          type: 'commit',
          repository: repositoryName,
          observedAt: commit.date || window.rangeEnd,
          locator: commit.url || `commit:${sha}`,
          claim: `Commit ${sha} was observed with subject: ${sanitizeDreamText(commit.message, 500)}`,
          excerpt: commit.message,
          provenanceGroup: sourceKey,
          independenceGroup: sourceKey,
        }))
        allowedRequests.push({ repository_id: repository.id, kind: 'commit', ref: String(sha), source_key: sourceKey })
      }
      for (const review of snapshot.hotPullRequests || []) {
        if (!review.number) continue
        const sourceKey = `${prefix}:code-review:${review.number}:observed:${window.rangeEnd}`
        addEvidence(evidence, evidenceRecord({
          sourceKey,
          type: 'code_review',
          repository: repositoryName,
          observedAt: review.updatedAt || window.rangeEnd,
          locator: review.url || `review:${review.number}`,
          claim: `${repository.sourceType === 'gerrit' ? 'Gerrit change' : 'GitHub pull request'} ${review.number} is ${review.state}: ${sanitizeDreamText(review.title, 500)}`,
          excerpt: canonicalJson({ title: review.title, state: review.state, labels: review.labels, additions: review.additions, deletions: review.deletions, changedFiles: review.changedFiles, comments: review.comments }),
          provenanceGroup: `${prefix}:code-review:${review.number}`,
          independenceGroup: `${prefix}:code-review:${review.number}`,
        }))
        allowedRequests.push({ repository_id: repository.id, kind: 'code_review', ref: String(review.number), source_key: sourceKey })
      }
      for (const issue of snapshot.issues || []) {
        const sourceKey = `${prefix}:issue:${issue.number}:observed:${issue.updatedAt || window.rangeEnd}`
        addEvidence(evidence, evidenceRecord({
          sourceKey,
          type: 'issue',
          repository: repositoryName,
          observedAt: issue.updatedAt || window.rangeEnd,
          locator: issue.url || `issue:${issue.number}`,
          claim: `Issue ${issue.number} is ${issue.state}: ${sanitizeDreamText(issue.title, 500)}`,
          excerpt: issue.title,
          provenanceGroup: `${prefix}:issue:${issue.number}`,
          independenceGroup: `${prefix}:issue:${issue.number}`,
        }))
      }
      for (const release of snapshot.releases || []) {
        const sourceKey = `${prefix}:release:${release.tag || release.name}`
        addEvidence(evidence, evidenceRecord({
          sourceKey,
          type: 'release',
          repository: repositoryName,
          observedAt: release.publishedAt || window.rangeEnd,
          locator: release.url || `release:${release.tag || release.name}`,
          claim: `Release ${release.tag || release.name} was published.`,
          excerpt: release.name || release.tag,
          provenanceGroup: sourceKey,
          independenceGroup: sourceKey,
        }))
      }
    }
  }
  return { windows: selected, inputManifest: manifest, evidenceCatalog: [...evidence.values()].sort((left, right) => left.source_key.localeCompare(right.source_key)), allowedRequests, diagnostics }
}

export function buildScoutContext({ run, state, horizon, observations, knownState, limits }) {
  const issuedIds = typedIds(limits)
  const context = {
    kind: 'dream_scout_context',
    schema_version: '2.1',
    run: {
      id: run.id,
      scope: run.scope,
      idempotency_key: run.idempotencyKey,
      horizon,
      cursor_before: state.cursor,
      known_state: state.versions,
    },
    input_manifest: observations.inputManifest,
    observations: observations.evidenceCatalog,
    repository_ids: [...new Set(observations.allowedRequests.map((item) => item.repository_id))],
    known_state: {
      signals: knownState.signals.map(compactSignal),
      topics: knownState.topics.map(compactTopic),
      forecasts: knownState.forecasts,
    },
    allowed_evidence_requests: observations.allowedRequests,
    candidate_ids: issuedIds.candidates,
    issued_ids: issuedIds,
    limits: { max_candidates: limits.maxCandidates, max_evidence_requests: limits.maxEvidenceRequests },
  }
  context.context_hash = contextHash(context)
  return context
}

export async function expandDreamEvidence({ settings, requests, repositories, scoutContext, maxEvidenceRequests, snoop = snoopChange }) {
  const allowed = new Set((scoutContext.allowed_evidence_requests || []).map((item) => `${item.repository_id}|${item.kind}|${item.ref}`))
  const evidence = new Map((scoutContext.observations || []).map((item) => [item.id, item]))
  const diagnostics = []
  for (const request of (requests || []).slice(0, maxEvidenceRequests)) {
    const key = `${request.repository_id}|${request.kind}|${request.ref}`
    if (!allowed.has(key)) {
      diagnostics.push(`Denied evidence request outside Host manifest: ${key}`)
      continue
    }
    if (request.kind === 'commit') continue
    const repository = repositories.find((item) => item.id === request.repository_id)
    if (!repository) {
      diagnostics.push(`Evidence repository is unavailable: ${request.repository_id}`)
      continue
    }
    try {
      const detail = await snoop(settings, repository, request.ref)
      const prefix = sourcePrefix(repository)
      const repositoryName = repositoryLabel(repository)
      const revision = detail.commits?.at(-1)?.fullSha || detail.commits?.at(-1)?.sha || `observed-${detail.collectedAt}`
      const reviewGroup = `${prefix}:code-review:${request.ref}:revision:${revision}`
      addEvidence(evidence, evidenceRecord({
        sourceKey: reviewGroup,
        type: 'code_review',
        repository: repositoryName,
        observedAt: detail.collectedAt,
        locator: detail.pullRequest?.url || `review:${request.ref}`,
        claim: `Expanded review ${request.ref}: ${sanitizeDreamText(detail.pullRequest?.title, 500)}`,
        excerpt: canonicalJson({ pullRequest: detail.pullRequest, commits: detail.commits, reviews: detail.reviews, comments: detail.comments?.slice(0, 20) }),
        provenanceGroup: reviewGroup,
        independenceGroup: reviewGroup,
      }))
      for (const file of (detail.files || []).slice(0, 40)) {
        if (!file.patch) continue
        const sourceKey = `${reviewGroup}:diff:${file.filename}:${sha256(file.patch).slice(0, 12)}`
        addEvidence(evidence, evidenceRecord({
          sourceKey,
          type: 'diff',
          repository: repositoryName,
          observedAt: detail.collectedAt,
          locator: `review:${request.ref}:file:${file.filename}`,
          claim: `Review ${request.ref} changes ${sanitizeDreamText(file.filename, 500)} (+${file.additions || 0}/-${file.deletions || 0}).`,
          excerpt: file.patch,
          provenanceGroup: reviewGroup,
          independenceGroup: reviewGroup,
        }))
      }
      for (const check of detail.checks || []) {
        const sourceKey = `${reviewGroup}:check:${check.name}:${check.conclusion || check.status}`
        addEvidence(evidence, evidenceRecord({
          sourceKey,
          type: 'test',
          repository: repositoryName,
          observedAt: detail.collectedAt,
          locator: check.url || `review:${request.ref}:check:${check.name}`,
          claim: `Check ${sanitizeDreamText(check.name, 300)} concluded ${check.conclusion || check.status}.`,
          excerpt: canonicalJson(check),
          provenanceGroup: reviewGroup,
          independenceGroup: sourceKey,
        }))
      }
    } catch (error) {
      diagnostics.push(`Evidence expansion failed for ${key}: ${sanitizeDreamText(error?.message || error, 600)}`)
    }
  }
  return { evidenceCatalog: [...evidence.values()].sort((left, right) => left.source_key.localeCompare(right.source_key)), diagnostics }
}

export function buildDreamContext({ run, state, horizon, observations, expandedEvidence, knownState, scout, limits, previousIssuedIds = null }) {
  const issuedIds = typedIds(limits, previousIssuedIds)
  const context = {
    kind: 'dream_context',
    schema_version: '2.1',
    run: {
      id: run.id,
      scope: run.scope,
      idempotency_key: run.idempotencyKey,
      horizon,
      cursor_before: state.cursor,
      known_state: state.versions,
    },
    input_manifest: observations.inputManifest,
    evidence_catalog: expandedEvidence.evidenceCatalog,
    known_state: {
      signals: knownState.signals.map(compactSignal),
      topics: knownState.topics.map(compactTopic),
      forecasts: knownState.forecasts,
      scout_candidates: scout.candidates || [],
    },
    issued_ids: issuedIds,
    limits: {
      max_signal_changes: limits.maxSignalChanges,
      max_topic_changes: limits.maxTopicChanges,
    },
  }
  context.context_hash = contextHash(context)
  const length = canonicalJson(context).length
  return {
    context,
    blocked: length > limits.contextMaxChars,
    diagnostics: [
      ...observations.diagnostics,
      ...expandedEvidence.diagnostics,
      ...(length > limits.contextMaxChars ? [`Dream context ${length} characters exceeds limit ${limits.contextMaxChars}; known state was not truncated.`] : []),
    ],
    metrics: { characters: length, inputs: context.input_manifest.length, evidence: context.evidence_catalog.length, knownSignals: context.known_state.signals.length, knownTopics: context.known_state.topics.length, openForecasts: context.known_state.forecasts.length },
  }
}
