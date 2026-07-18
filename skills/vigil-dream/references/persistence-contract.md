# Host persistence contract

## Authority

The database is authoritative. Prepared context, raw provider output, and accepted batch are immutable audit artifacts identified by hash. The model never owns locks, versions, evidence identity, or cursor movement.

## Run lifecycle

1. Claim a scope/horizon using a database lease and deterministic idempotency key.
2. Read cursor and Signal/Topic/Evidence ledger versions.
3. Build and hash the complete prepared context.
4. Invoke Dream outside a database write transaction.
5. Parse one JSON object and validate schema, semantics, and context binding.
6. Start a short write transaction and re-check lease, cursor, and ledger versions.
7. Insert Host evidence, append entity revisions/evaluations, update current projections, record the accepted batch, increment affected versions, and advance cursor last.
8. Commit or roll back everything.

`finding` and `no_finding` completion is idempotent for one scope/horizon/protocol. Failed and blocked attempts remain queryable and do not mutate domain ledgers.

## Identity and uniqueness

- Entity and revision IDs are globally unique and Host-issued.
- Evidence source key and evidence ID are unique.
- Current and alias fingerprints have one owner.
- One accepted evaluation closes one forecast.
- Revision sequence is monotonic per entity.
- A scope has one cursor and independent Signal, Topic, and Evidence versions.

## Concurrency

Provider work never holds the SQLite writer lock. Claims use leases; final apply uses optimistic ledger versions and a short `BEGIN IMMEDIATE` transaction. A stale batch is rejected and rebuilt against the new state.

## Failure behavior

Malformed output, unknown evidence/IDs, stale versions, duplicate fingerprints, partial SQL failure, or expired lease cannot advance the cursor. Operational errors are sanitized before public exposure. Raw source snippets, local paths, credentials, and prompt payloads are not public projections.
