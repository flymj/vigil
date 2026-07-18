# Dream v2.1 contract

## Contents

1. Prepared context
2. Evidence
3. Known state
4. Batch envelope
5. Signal changes
6. Forecasts
7. Topic decisions
8. Candidate and suppression audit
9. Validation invariants

## Prepared context

The Host creates a `dream_context` before provider invocation. `context_hash` is the SHA-256 of canonical JSON with the hash field omitted.

The context contains immutable run identity, scope, closed horizon, cursor, ledger versions, input manifest, evidence catalog, compact known-state index, detailed relevant known records, and typed issued-ID pools. The batch must echo the run identity, horizon, cursor, versions, and context hash exactly.

## Evidence

Evidence IDs use `ev-` plus the first 16 hex characters of SHA-256 over `source_key`. The Host is the only evidence author.

Logical evidence types:

| Type | Tier | Directness |
|---|---:|---|
| `commit`, `diff`, `test`, `benchmark` | 1 | direct |
| `code_review`, `issue`, `design_document`, `release` | 2 | intent |
| `window_summary`, `repository_summary` | 3 | derived |

Provider-specific locators remain inside Host evidence metadata. A GitHub PR and Gerrit change are both `code_review`; their canonical source keys encode provider, host, project, immutable number/revision, and branch where relevant.

Derived evidence helps locate primary material and cannot inherit stronger authority. `truncated: true` means omitted content cannot be treated as complete proof.

## Known state

Signal and Topic IDs are stable UUID-based identities. Revisions are append-only. A fingerprint is a normalized semantic index with one current value and append-only aliases.

The compact index includes every active entity. Detailed records are selected deterministically for candidate comparison. Open forecasts are always included in full. If the compact index cannot fit the hard context allocation, the Host blocks the run instead of hiding state.

## Batch envelope

One `dream_batch` has:

- `kind: dream_batch` and `schema_version: 2.1`;
- an immutable `run` envelope;
- `signal_changes`;
- one `topic_decision` plus `topic_changes`;
- evidence references only, never model-authored evidence.

Accepted outcomes (`findings`, `state_updated`, `duplicate_only`, `no_finding`) advance the cursor only after atomic persistence. `blocked_incomplete_sources` never advances it.

## Signal changes

Change types are `create`, `update`, `status_change`, and `supersede`. Each change references a run candidate and a typed issued change/revision ID.

Signal revision fields include current/alias fingerprint, title, lifecycle status, repositories, summary, baseline, delta, mechanism, consequence, evidence boundary, direction, importance, confidence, facts, inferences, counter-evidence, unknowns, next checks, evidence IDs, forecast evaluations, and new forecasts.

A changed fingerprint must retain the previous current fingerprint as an alias. A create may not collide with any current or alias fingerprint. Supersession must be paired in both directions and cannot form a cycle or fork.

## Forecasts

Forecasts are immutable claims with an observation due time and expected observations. An evaluation is a separate append-only object that closes the effective open state. Every due/touched open forecast gets one evaluation in an accepted batch. Replacement forecasts use globally new Host-issued IDs.

## Topic decisions

`topic_decision.action` is one of `none`, `link`, `update`, or `create`. Topic changes use stable IDs and append-only revisions. Topics cite Signals and Host evidence and must add mechanism-level information beyond Signal wording.

## Candidate and suppression audit

Every accepted Signal/Topic change references one `run.candidates` entry. Candidates record compared entity IDs and a disposition. Suppression groups may reference only source keys present in the Host evidence catalog. Canonical and suppressed membership must agree with Host provenance.

## Validation invariants

Validation runs in three layers:

1. JSON Schema draft 2020-12 rejects shape and extra properties.
2. Semantic validation checks IDs, outcomes, evidence quality, identity, forecast, Topic, candidate, and supersession rules.
3. Context validation binds the batch to the exact Host context, evidence catalog, known ledger versions, and issued IDs.

No layer repairs model output. Parse, validation, concurrency, or persistence failure leaves the cursor and ledgers unchanged.
