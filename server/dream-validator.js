import { readFileSync } from 'node:fs'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { contextHash, evidenceId } from './dream-safety.js'

const batchSchema = JSON.parse(readFileSync(new URL('../skills/vigil-dream/schemas/dream-batch.schema.json', import.meta.url), 'utf8'))
const scoutSchema = JSON.parse(readFileSync(new URL('../skills/vigil-dream/schemas/dream-scout.schema.json', import.meta.url), 'utf8'))
const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const validateBatchSchema = ajv.compile(batchSchema)
const validateScoutSchema = ajv.compile(scoutSchema)

const acceptedOutcomes = new Set(['findings', 'state_updated', 'duplicate_only', 'no_finding'])
const blockedOutcome = 'blocked_incomplete_sources'

export class DreamValidationError extends Error {
  constructor(message, errors = []) {
    super(message)
    this.name = 'DreamValidationError'
    this.errors = errors
  }
}

function schemaErrors(validator) {
  return (validator.errors || []).map((error) => `${error.instancePath || '/'} ${error.message}`)
}

function set(values) {
  return new Set(Array.isArray(values) ? values : [])
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function references(change) {
  const revision = change.revision || {}
  const ids = new Set([...(revision.evidence_ids || []), ...(revision.counter_evidence_ids || [])])
  for (const fact of revision.facts || revision.findings || []) for (const id of fact.evidence_ids || []) ids.add(id)
  for (const evaluation of revision.forecast_evaluations || []) for (const id of evaluation.evidence_ids || []) ids.add(id)
  return ids
}

function difference(left, right) {
  return [...left].filter((item) => !right.has(item))
}

function validateSupersession(changes, entityKey, label, errors) {
  const byId = new Map(changes.map((change) => [change[entityKey], change]))
  const replacements = new Map()
  for (const change of changes) {
    const oldId = change.revision?.supersedes
    if (oldId) {
      if (replacements.has(oldId) && replacements.get(oldId) !== change[entityKey]) errors.push(`${label}: one entity has multiple replacements`)
      replacements.set(oldId, change[entityKey])
    }
  }
  for (const change of changes) {
    const entityId = change[entityKey]
    const oldId = change.revision?.supersedes
    const newId = change.revision?.superseded_by
    if (oldId && byId.get(oldId)?.revision?.superseded_by !== entityId) errors.push(`${label}: supersedes requires a paired old revision`)
    if (newId && byId.get(newId)?.revision?.supersedes !== entityId) errors.push(`${label}: superseded_by requires a paired replacement revision`)
  }
  for (const start of replacements.keys()) {
    const seen = new Set()
    let current = start
    while (replacements.has(current)) {
      if (seen.has(current)) { errors.push(`${label}: supersession cycle`); break }
      seen.add(current)
      current = replacements.get(current)
    }
  }
}

export function parseStrictDreamJson(content) {
  const text = String(content || '').trim()
  if (!text) throw new DreamValidationError('Provider returned an empty Dream response')
  if (text.startsWith('```') || text.endsWith('```')) throw new DreamValidationError('Dream response must be one raw JSON object without Markdown fences')
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new DreamValidationError(`Dream response is not valid JSON: ${error.message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DreamValidationError('Dream response root must be one JSON object')
  return value
}

export function validatePreparedContext(context) {
  const errors = []
  const keys = ['kind', 'schema_version', 'run', 'input_manifest', 'evidence_catalog', 'known_state', 'issued_ids', 'limits', 'context_hash']
  if (!context || typeof context !== 'object' || Array.isArray(context)) return ['context must be an object']
  const missing = keys.filter((key) => !(key in context))
  const extra = Object.keys(context).filter((key) => !keys.includes(key))
  if (missing.length) errors.push(`context missing properties: ${missing.join(', ')}`)
  if (extra.length) errors.push(`context unexpected properties: ${extra.join(', ')}`)
  if (context.kind !== 'dream_context' || context.schema_version !== '2.1') errors.push('context kind/schema version is invalid')
  if (context.context_hash !== contextHash(context)) errors.push('context hash does not match canonical Host context')
  const ids = new Set()
  const sources = new Set()
  for (const item of context.evidence_catalog || []) {
    if (item.id !== evidenceId(item.source_key)) errors.push(`evidence ${item.id}: ID does not match source key`)
    if (ids.has(item.id)) errors.push(`evidence ${item.id}: duplicate ID`)
    if (sources.has(item.source_key)) errors.push(`evidence ${item.source_key}: duplicate source key`)
    ids.add(item.id)
    sources.add(item.source_key)
  }
  return errors
}

export function validateDreamScout(scout, context) {
  const errors = []
  if (!validateScoutSchema(scout)) errors.push(...schemaErrors(validateScoutSchema))
  if (scout?.context_hash !== context?.context_hash) errors.push('scout context_hash must equal Host scout context')
  const issued = set(context?.candidate_ids)
  const candidateIds = new Set()
  const observations = set((context?.observations || []).map((item) => item.id))
  const repositoryIds = set(context?.repository_ids)
  const knownSignals = set((context?.known_state?.signals || []).map((item) => item.id))
  const knownTopics = set((context?.known_state?.topics || []).map((item) => item.id))
  const allowed = new Set((context?.allowed_evidence_requests || []).map((item) => `${item.repository_id}|${item.kind}|${item.ref}`))
  for (const candidate of scout?.candidates || []) {
    if (!issued.has(candidate.id)) errors.push(`scout candidate ${candidate.id} was not issued by Host`)
    if (candidateIds.has(candidate.id)) errors.push(`scout candidate ${candidate.id} is duplicated`)
    candidateIds.add(candidate.id)
    for (const id of candidate.repository_ids || []) if (!repositoryIds.has(id)) errors.push(`scout candidate references unknown repository ${id}`)
    for (const id of candidate.source_refs || []) if (!observations.has(id)) errors.push(`scout candidate references unknown observation ${id}`)
    for (const id of candidate.compared_signal_ids || []) if (!knownSignals.has(id)) errors.push(`scout candidate references unknown Signal ${id}`)
    for (const id of candidate.compared_topic_ids || []) if (!knownTopics.has(id)) errors.push(`scout candidate references unknown Topic ${id}`)
  }
  for (const request of scout?.evidence_requests || []) {
    if (!candidateIds.has(request.candidate_id)) errors.push(`evidence request references unknown candidate ${request.candidate_id}`)
    const key = `${request.repository_id}|${request.kind}|${request.ref}`
    if (!allowed.has(key)) errors.push(`evidence request is outside Host manifest: ${key}`)
  }
  if ((scout?.candidates || []).length > Number(context?.limits?.max_candidates || 0)) errors.push('scout exceeds Host candidate limit')
  if ((scout?.evidence_requests || []).length > Number(context?.limits?.max_evidence_requests || 0)) errors.push('scout exceeds Host evidence request limit')
  return errors
}

export function assertValidDreamScout(scout, context) {
  const errors = validateDreamScout(scout, context)
  if (errors.length) throw new DreamValidationError('Dream scout validation failed', errors)
  return scout
}

export function validateDreamBatch(batch, context) {
  const errors = [...validatePreparedContext(context)]
  if (!validateBatchSchema(batch)) errors.push(...schemaErrors(validateBatchSchema))
  if (!batch?.run) return [...errors, 'batch.run is missing']
  const run = batch.run
  const prepared = context.run || {}
  for (const [name, expected] of Object.entries({ id: prepared.id, scope: prepared.scope, horizon: prepared.horizon, context_hash: context.context_hash, idempotency_key: prepared.idempotency_key, known_state: prepared.known_state })) {
    if (!deepEqual(run[name], expected)) errors.push(`batch.run.${name} must equal Host-prepared value`)
  }
  if (run.cursor?.before !== prepared.cursor_before) errors.push('batch cursor.before must equal Host cursor')
  if (run.cursor?.candidate_after !== prepared.horizon?.end) errors.push('batch cursor.candidate_after must equal Host horizon end')
  if (run.outcome === blockedOutcome) {
    if (run.cursor?.advance_on_publish !== false) errors.push('blocked batch cannot advance cursor')
    if (batch.signal_changes?.length || batch.topic_changes?.length) errors.push('blocked batch cannot contain entity changes')
  } else if (acceptedOutcomes.has(run.outcome)) {
    if (run.cursor?.advance_on_publish !== true) errors.push('accepted batch must advance cursor')
  } else errors.push(`invalid Dream outcome ${run.outcome}`)

  if ((batch.signal_changes || []).length > Number(context.limits?.max_signal_changes || 0)) errors.push('Signal changes exceed Host limit')
  if ((batch.topic_changes || []).length > Number(context.limits?.max_topic_changes || 0)) errors.push('Topic changes exceed Host limit')

  const candidates = new Map((run.candidates || []).map((item) => [item.id, item]))
  const issuedCandidates = set(context.issued_ids?.candidates)
  for (const id of candidates.keys()) if (!issuedCandidates.has(id)) errors.push(`candidate ${id} was not issued by Host`)
  const evidence = new Map((context.evidence_catalog || []).map((item) => [item.id, item]))
  const sourceByKey = new Map((context.evidence_catalog || []).map((item) => [item.source_key, item]))
  for (const group of run.suppression_groups || []) {
    if (!set(context.issued_ids?.suppression_groups).has(group.id)) errors.push(`suppression ${group.id} was not issued by Host`)
    const canonical = sourceByKey.get(group.canonical_source_key)
    if (!canonical || !canonical.canonical) errors.push(`suppression ${group.id} canonical source is not canonical Host evidence`)
    for (const sourceKey of group.suppressed_source_keys || []) {
      const item = sourceByKey.get(sourceKey)
      if (!item || item.canonical || item.duplicate_of !== canonical?.id) errors.push(`suppression ${group.id} is inconsistent with Host duplicate lineage`)
    }
  }

  const knownSignals = new Map((context.known_state?.signals || []).map((item) => [item.id, item]))
  const knownTopics = new Map((context.known_state?.topics || []).map((item) => [item.id, item]))
  const knownForecasts = new Map((context.known_state?.forecasts || []).map((item) => [item.id, item]))
  const fingerprintOwners = new Map()
  for (const signal of knownSignals.values()) for (const fingerprint of [signal.fingerprint?.current, ...(signal.fingerprint?.aliases || [])].filter(Boolean)) fingerprintOwners.set(fingerprint, signal.id)
  const touchedSignals = new Set()
  const evaluated = new Set()

  for (const [index, change] of (batch.signal_changes || []).entries()) {
    const label = `signal_changes[${index}]`
    const candidate = candidates.get(change.candidate_id)
    if (!candidate) errors.push(`${label} references an unknown run candidate`)
    if (candidate?.disposition === 'duplicate' || candidate?.disposition === 'rejected' || candidate?.disposition === 'deferred') errors.push(`${label} cannot use candidate disposition ${candidate.disposition}`)
    if (!set(context.issued_ids?.signal_changes).has(change.change_id)) errors.push(`${label}.change_id was not issued for Signals`)
    if (!set(context.issued_ids?.signal_revisions).has(change.revision?.id)) errors.push(`${label}.revision.id was not issued for Signals`)
    const existing = knownSignals.get(change.signal_id)
    if (change.change_type === 'create') {
      if (!set(context.issued_ids?.signals).has(change.signal_id) || existing) errors.push(`${label}.signal_id is not a valid create identity`)
      if (candidate?.disposition !== 'promoted_new') errors.push(`${label} create requires promoted_new candidate disposition`)
    } else if (!existing) errors.push(`${label}.signal_id is not a known Signal`)
    touchedSignals.add(change.signal_id)
    const fingerprint = change.revision?.fingerprint || {}
    const owner = fingerprintOwners.get(fingerprint.current)
    if (owner && owner !== change.signal_id) errors.push(`${label} fingerprint already belongs to ${owner}`)
    if (existing?.fingerprint?.current && existing.fingerprint.current !== fingerprint.current && !(fingerprint.aliases || []).includes(existing.fingerprint.current)) errors.push(`${label} must retain the previous current fingerprint as an alias`)
    const refs = references(change)
    const unknownEvidence = difference(refs, new Set(evidence.keys()))
    if (unknownEvidence.length) errors.push(`${label} references evidence not issued by Host: ${unknownEvidence.join(', ')}`)
    if (change.change_type === 'create' || change.change_type === 'update') {
      const canonicalEvidence = [...refs].map((id) => evidence.get(id)).filter((item) => item?.canonical)
      const groups = new Set(canonicalEvidence.map((item) => item.independence_group).filter(Boolean))
      const hasStrong = canonicalEvidence.some((item) => Number(item.tier) <= 2)
      const directHigh = Number(change.revision?.importance || 0) >= 0.75 && canonicalEvidence.some((item) => Number(item.tier) === 1 && item.directness === 'direct')
      if (!((groups.size >= 2 && hasStrong) || directHigh)) errors.push(`${label} does not satisfy the evidence promotion gate`)
    }
    for (const evaluation of change.revision?.forecast_evaluations || []) {
      if (!set(context.issued_ids?.forecast_evaluations).has(evaluation.id)) errors.push(`${label} forecast evaluation ID was not issued by Host`)
      if (!knownForecasts.has(evaluation.forecast_id)) errors.push(`${label} evaluates an unknown forecast`)
      if (evaluated.has(evaluation.forecast_id)) errors.push(`${label} evaluates forecast ${evaluation.forecast_id} more than once`)
      evaluated.add(evaluation.forecast_id)
    }
    for (const forecast of change.revision?.forecasts || []) {
      if (!set(context.issued_ids?.forecasts).has(forecast.id) || knownForecasts.has(forecast.id)) errors.push(`${label} forecast ID was not issued or is already known`)
    }
  }
  for (const forecast of knownForecasts.values()) {
    const due = forecast.due_at && forecast.due_at <= prepared.horizon?.end
    const touched = touchedSignals.has(forecast.signal_id)
    if ((forecast.status || 'open') === 'open' && (due || touched) && !evaluated.has(forecast.id) && run.outcome !== blockedOutcome) errors.push(`forecast ${forecast.id} is due/touched and must be evaluated`)
  }

  const createdSignals = new Set((batch.signal_changes || []).filter((item) => item.change_type === 'create').map((item) => item.signal_id))
  for (const [index, change] of (batch.topic_changes || []).entries()) {
    const label = `topic_changes[${index}]`
    if (!candidates.has(change.candidate_id)) errors.push(`${label} references an unknown run candidate`)
    if (!set(context.issued_ids?.topic_changes).has(change.change_id)) errors.push(`${label}.change_id was not issued for Topics`)
    if (!set(context.issued_ids?.topic_revisions).has(change.revision?.id)) errors.push(`${label}.revision.id was not issued for Topics`)
    const existing = knownTopics.get(change.topic_id)
    if (change.change_type === 'create') {
      if (!set(context.issued_ids?.topics).has(change.topic_id) || existing) errors.push(`${label}.topic_id is not a valid create identity`)
    } else if (!existing) errors.push(`${label}.topic_id is not a known Topic`)
    const unknownSignals = (change.revision?.signal_ids || []).filter((id) => !knownSignals.has(id) && !createdSignals.has(id))
    if (unknownSignals.length) errors.push(`${label} references unknown Signals: ${unknownSignals.join(', ')}`)
    const unknownEvidence = difference(references(change), new Set(evidence.keys()))
    if (unknownEvidence.length) errors.push(`${label} references evidence not issued by Host: ${unknownEvidence.join(', ')}`)
  }
  if (batch.topic_decision?.action === 'none' && batch.topic_changes?.length) errors.push('topic_decision none cannot contain Topic changes')
  if (batch.topic_decision?.action !== 'none' && !batch.topic_changes?.length) errors.push('topic_decision requires at least one Topic change')
  if ((run.outcome === 'duplicate_only' || run.outcome === 'no_finding') && (batch.signal_changes?.length || batch.topic_changes?.length)) errors.push(`${run.outcome} cannot contain entity changes`)
  if ((run.outcome === 'findings' || run.outcome === 'state_updated') && !batch.signal_changes?.length && !batch.topic_changes?.length && !evaluated.size) errors.push(`${run.outcome} must contain a material state change`)
  validateSupersession(batch.signal_changes || [], 'signal_id', 'Signal supersession', errors)
  validateSupersession(batch.topic_changes || [], 'topic_id', 'Topic supersession', errors)
  return [...new Set(errors)]
}

export function assertValidDreamBatch(batch, context) {
  const errors = validateDreamBatch(batch, context)
  if (errors.length) throw new DreamValidationError('Dream batch validation failed', errors)
  return batch
}
