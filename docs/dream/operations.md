# Operating VIGIL Dream

Dream is disabled by default and must be enabled independently for each local VIGIL workspace.

## Prerequisites

- Node.js `>= 24.15.0`, because the ledger uses the built-in `node:sqlite` API.
- A writable owner-controlled VIGIL workspace.
- At least one watched GitHub or Gerrit repository.
- An OpenAI-compatible Provider and sufficient output capacity for strict JSON synthesis.
- Window scheduling enabled with a `00:00` publication boundary.
- Identical valid IANA timezones for Window and Dream schedules.
- A durable `published` or `degraded` midnight Window for the day being processed.

Run these checks before enabling Dream:

```bash
node --version
npm test
python3 -m unittest discover -s skills/vigil-dream/tests -p 'test_*.py'
npm run build
```

## Configuration

Open **访问与系统 → 分析引擎**. Configure and save **Window Schedule** first, then **Dream / Protocol v2.1**. The committed defaults are conservative:

| Setting | Default | Purpose |
| --- | ---: | --- |
| enabled | `false` | Explicit rollout gate |
| publish delay | 10 minutes | Wait after the local midnight Window boundary |
| catch-up | 7 days | Bound restart work |
| attempts | 3 | Bound durable retries |
| lease | 900 seconds | Prevent concurrent owners |
| Scout candidates | 4 | Bound initial semantic search |
| evidence requests | 6 | Bound Host-side evidence expansion |
| Signal changes | 3 | Bound one accepted batch |
| Topic changes | 2 | Bound one accepted batch |
| Scout output | 4,000 tokens | Bound candidate selection |
| synthesis output | 16,000 tokens | Leave room for audited strict JSON |
| context | 180,000 characters | Bound provider input |

Saving settings rescans eligible closed horizons. Enabling Dream does not create an unfinished day and does not modify the Window schedule for you.

## Files and inspection

- non-secret settings: `.vigil/analysis.json` under `VIGIL_CONFIG_DIR`;
- authoritative ledger and run audit: `<workspace>/dream.sqlite3`;
- SQLite WAL files while the service is active: `dream.sqlite3-wal` and `dream.sqlite3-shm`;
- reasoning contract and schemas: `skills/vigil-dream/`.

The product surfaces operational state in **访问与系统 → 系统状态**, and domain state in **技术信号** and **技术主题**. Read-only APIs are:

```text
GET /api/signals
GET /api/signals/:id
GET /api/signals/:id/revisions
GET /api/signals/:id/forecasts
GET /api/topics
GET /api/topics/:id
GET /api/topics/:id/revisions
GET /api/topics/:id/signals
GET /api/dream-runs
GET /api/dream-runs/:id
```

Authenticated run detail includes the bounded Scout context/output, immutable synthesis context, raw JSON output, and accepted batch. Public domain detail intentionally excludes those fields and all raw evidence excerpts.

## Manual run and retry

An authenticated administrator can use **Dream now** on the Signal or Topic page. It selects only the most recent closed eligible daily horizon and still requires a durable midnight Window. The equivalent endpoints are:

```text
POST /api/dream-runs/trigger
POST /api/dream-runs/:id/retry
```

The client cannot submit an arbitrary range. Repeating a trigger for the same scope and horizon resolves through the same idempotency key. Retry reuses the original horizon and is allowed only for a terminal blocked or failed run.

## Outcome diagnosis

- **no finding / duplicate only:** healthy completion. The cursor advances; do not retry simply to force content.
- **blocked:** inspect the run diagnostics for a missing midnight Window, incomplete durable inputs, or a Scout-declared evidence boundary. The cursor remains unchanged.
- **failed at scout/synthesis:** inspect Provider reachability, model name, token capacity, and strict JSON output in authenticated run detail.
- **failed at validation:** compare diagnostics with `skills/vigil-dream/references/schema.md`; unknown evidence/IDs, stale forecasts, incomplete candidate audits, and mismatched Host fields are deliberately rejected.
- **failed at commit:** inspect lease expiry, SQLite busy/corruption, foreign keys, and prepared ledger versions. The transaction and cursor were rolled back.
- **unavailable:** system status lists exact readiness reasons; most commonly Window scheduling is disabled, `00:00` is absent, or timezones differ.

Do not convert blocked or failed runs into `no_finding`. Fix the operational cause and use the persisted retry path.

## Backup, recovery, and rollback

For a consistent filesystem backup, stop the VIGIL API, copy `dream.sqlite3` to an owner-only backup location, then restart. If using SQLite tooling while the service is running, use its online `.backup` command rather than copying only the main file and omitting WAL state.

For a stale running attempt, wait for its lease to expire and use retry or restart the scheduler. A subsequent claim increments the attempt and receives a new lease token; it does not create a second identity.

If corruption is suspected:

1. Disable Dream and stop the API.
2. Preserve the database and any `-wal`/`-shm` files as forensic copies.
3. Run `PRAGMA integrity_check` on a copy.
4. Restore the latest known-good complete backup, or repair into a new database under operator control.
5. Restart with Dream disabled, inspect status and projections, then explicitly re-enable.

Do not delete the ledger as a routine retry mechanism: that discards deduplication history, aliases, forecasts, evaluations, and the accepted cursor. The service also refuses to open a database whose schema version is newer than the running code.

To roll back product behavior, disable Dream first and keep the database intact. Older code may be deployed only if it is compatible with the existing schema. Window and repository intelligence continue to operate while Dream is disabled.

## Remote rollout gate

Local verification does not enable a remote deployment. Before a later remote enablement, an operator must confirm the deployed Node version, one-writer workspace topology, filesystem permissions and capacity, backup/restore procedure, Provider model/output budget, midnight Window durability, and observability ownership. Change `dreamSchedule.enabled` remotely only after those checks are approved.
