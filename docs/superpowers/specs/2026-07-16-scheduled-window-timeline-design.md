# Scheduled Repository Windows and Dynamic Timeline Design

**Date:** 2026-07-16  
**Status:** Approved direction; ready for implementation planning

## Purpose

Vigil currently collects repository intelligence only on demand. This design adds a local, durable scheduled pipeline that turns watched repositories into published cross-repository **Windows**. A Window is a completed, fixed time interval containing repository sync/collection results, per-repository reports, an aggregate report, and an event timeline.

The primary product surface is a dynamic **Window Rail**: it shows the pipeline's real events as a Window runs and remains a replayable archive after publication.

## Scope and exclusions

In scope:

- A local in-process scheduler, configured by an administrator.
- Default Window publication at `00:00`, `08:00`, and `16:00` in `Asia/Shanghai`.
- Durable Window runs, artifacts, retry state, and event history under the configured Vigil workspace.
- Automatic catch-up for ended but unpublished Windows after process restart.
- Per-repository isolation and degraded publication.
- A live Window Rail with real events over Server-Sent Events (SSE), static event replay, report downloads, and repository drill-down.

Out of scope:

- DingTalk or any other notification delivery.
- A separate worker process, distributed locks, or multi-instance coordination.
- Repository Lanes as a primary view; they remain a later drill-down enhancement.
- Invented timeline activity, placeholder signals, or synthetic progress.
- Changing the existing manual repository-intelligence workflow.

## Window calendar and configuration

`analysis.json` gains a `windowSchedule` setting. Its defaults preserve the current product behavior: scheduling is disabled until an administrator enables it.

```json
{
  "enabled": false,
  "timezone": "Asia/Shanghai",
  "publishTimes": ["00:00", "08:00", "16:00"],
  "repositoryConcurrency": 3,
  "maxCatchUpWindows": 12,
  "maxAttempts": 3
}
```

The administrator can later change the IANA timezone and publication times. Validation rejects invalid timezones, malformed `HH:mm` values, empty schedules, non-positive concurrency, and invalid bounds. Valid publication times are sorted and deduplicated before persistence, so the saved configuration is canonical.

Each publish time closes the preceding Window. With the default schedule:

| Publish time | Window interval |
| --- | --- |
| 00:00 | `[previous day 16:00, current day 00:00)` |
| 08:00 | `[00:00, 08:00)` |
| 16:00 | `[08:00, 16:00)` |

Intervals are half-open and interpreted in the configured timezone. Persisted timestamps are UTC ISO timestamps; the timezone and wall-clock schedule used to derive them stay with every Window so history remains interpretable after settings change.

Timezone boundary calculation uses Luxon and the platform `Intl` IANA timezone data rather than hand-written offset arithmetic. This handles daylight-saving transitions for arbitrary administrator-selected zones.

## Durable data model

The scheduler has one durable ledger at `<workspace>/window-runs.json`, written atomically with the same temp-file-and-rename approach used by the watchlist. Large, user-facing results are saved beneath `<workspace>/artifacts/windows/<window-id>/`.

`windowId` is derived only from the normalized UTC range boundaries. Therefore, a given range has one stable identity regardless of retries or restart.

Each ledger record contains:

- immutable range identity: `id`, `rangeStart`, `rangeEnd`, `timezone`, `publishTime`;
- lifecycle: `status` (`queued`, `running`, `published`, `degraded`, `failed`), `attempt`, `nextRetryAt`, `startedAt`, `finishedAt`;
- a snapshot of the watched repositories selected at run start;
- per-repository pipeline outcome and safe error text;
- ordered, persisted timeline events;
- artifact paths and aggregate outcome metadata.

The corresponding artifact directory contains `window.json` for machine use and `window.md` for a readable report. Per-repository summaries continue to use the existing repository-summary artifact storage, with their artifact references recorded in the Window.

No access token, authorization header, provider secret, or raw credential is ever persisted in events, errors, reports, or SSE payloads.

## Scheduler lifecycle and idempotency

The API process owns one scheduler instance. On startup it validates settings, recovers stale `running` records by returning them to the retry queue, scans for completed unpublished intervals, then arms one timer for the next publication boundary. After every run it scans again and re-arms the timer.

The catch-up scan creates or resumes only windows whose `rangeEnd` is at or before the current time. It walks forward in chronological order, is limited to `maxCatchUpWindows`, and never starts the current unfinished interval early.

Ledger mutation serializes claims within the process. Claiming a Window atomically changes it from eligible (`queued`, or `failed` with a due retry) to `running`; a second timer tick, manual trigger, or catch-up scan cannot claim it while it is running or terminal. This provides exactly-one active attempt per Window in the supported single-process deployment.

Failures retry the same Window up to `maxAttempts`, with persisted exponential backoff beginning at five minutes. Once attempts are exhausted, the Window is terminal `failed` and remains visible for an administrator to retry manually. A manual retry creates a new attempt for the same range and never duplicates its report identity.

## Pipeline

At the start of an attempt, Vigil snapshots the eligible watchlist. The Window then processes repositories through a bounded concurrency queue:

1. Emit `repository.sync.started`.
2. For `full` watches, run the existing local clone/fetch/checkout synchronization. For on-demand watches, emit a metadata-refresh event and retain the current remote-only collection path.
3. Collect the source window using the existing GitHub or Gerrit adapter with the Window's exact range.
4. Build and persist the repository summary, using the configured provider when available and the existing structured summary fallback otherwise.
5. Emit success or failure events with elapsed time and safe, actionable error messages.

After all repository jobs settle, Vigil aggregates the successful repository snapshots into a Window report. It can use the configured provider with bounded repository inputs, and falls back to a deterministic structured aggregate if provider execution is unavailable or fails. It persists the Window artifact before announcing publication.

Outcome policy:

- all repositories succeed: `published`;
- one or more repositories succeed and one or more fail: `degraded`, with failures identified in the report and rail;
- no repository succeeds: `failed`, with a retry schedule or final failure state.

A single repository never prevents other repositories from completing. A successful partial Window is published once; it is not silently rerun merely because a sibling failed.

## Event stream and Window Rail

All lifecycle changes produce an ordered event in the durable ledger and publish the same sanitized event to an in-memory event hub. Event names include:

- `window.queued`, `window.started`, `window.aggregate.started`, `window.published`, `window.degraded`, `window.failed`;
- `repository.sync.started`, `repository.sync.succeeded`, `repository.sync.failed`;
- `repository.collect.started`, `repository.collect.succeeded`, `repository.collect.failed`;
- `repository.summary.succeeded`, `repository.summary.failed`.

`GET /api/windows/:id/events` is an SSE endpoint. On connect it replays the persisted events in sequence, then streams new live events until the client disconnects. The UI may reconnect safely: it derives its display from the API record plus idempotent ordered events rather than treating a single transient SSE connection as authoritative.

The Windows page replaces its empty state with Window Rail as the primary view:

- archive cards for past Windows, showing interval, status, success/failure count, and report availability;
- a highlighted current/recent Window with a now marker, subtle live progress, and true event fall-in;
- event selection opens a drawer with timestamps, repository, outcome, error detail, and linked report when applicable;
- Window detail includes aggregate report and JSON/Markdown downloads;
- repository lanes are a secondary drill-down view, not the landing view.

The timeline is intentionally an operational narrative, not a log waterfall. It renders only data from persisted Window records and SSE events. At high event density, it may group rendered markers while retaining the full ordered event list in the detail drawer.

## API and settings surfaces

The existing analysis settings endpoints carry `windowSchedule`; no parallel settings model is introduced.

New Window endpoints:

- `GET /api/windows` — archive list and current run summary;
- `GET /api/windows/:id` — full durable Window record and report references;
- `GET /api/windows/:id/events` — SSE replay plus live events;
- `GET /api/windows/:id/download?format=json|markdown` — saved aggregate artifacts;
- `POST /api/windows/trigger` — authenticated administrator manual run request for an eligible completed range;
- `POST /api/windows/:id/retry` — authenticated administrator retry of a terminal failed Window.

Read endpoints follow the existing public-read policy. Mutation endpoints follow the existing authenticated-administrator policy. `GET /api/system/status` reports whether scheduling is enabled, the timezone, next publish boundary, current run, and most recent completed Window, replacing the prior hard-coded “on-demand” description.

## Testing and verification

Automated tests cover:

- schedule normalization and timezone boundary derivation, including the default three slots;
- startup catch-up, unfinished-window exclusion, stale-running recovery, retry limits, and duplicate claim prevention;
- isolated repository outcomes, `published`/`degraded`/`failed` state selection, and artifact persistence;
- event ordering, durable replay, and safe SSE payloads;
- settings and system-status default compatibility;
- API authorization for the mutation endpoints.

Implementation is test-driven. Each test run uses an isolated `VIGIL_CONFIG_DIR`, because the local runtime's configured GitHub credential is intentionally not part of test assumptions. Final verification includes the complete test suite, production build, and a live local run showing a real Window timeline and a persisted report.

## Acceptance criteria

With scheduling enabled and the default timezone/times, Vigil can restart after a missed `08:00` boundary, create exactly the closed `[00:00, 08:00)` Window, process every repository independently, persist its report and events, and publish `degraded` when some repositories fail. It must not create the in-progress `[08:00, 16:00)` Window early, duplicate a live attempt, reveal credentials, or require DingTalk configuration.
