# Scheduled Repository Windows and Dynamic Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable, local scheduled repository-intelligence pipeline that publishes cross-repository Windows and shows their real-time and archived events in a Window Rail.

**Architecture:** Settings own a validated timezone-aware schedule; a single in-process scheduler derives completed intervals and delegates durable claims to a Window ledger. A Window runner isolates repository jobs, persists artifacts and ordered events, then exposes durable records plus an SSE live stream. React reads the archive, attaches to the selected Window's SSE endpoint, and renders the Window Rail with a details drawer.

**Tech Stack:** Node.js ESM, Express 5, React 19, Luxon 3, Server-Sent Events, atomic JSON files, `node:test`, Vite.

## Global Constraints

- Default scheduling remains disabled; once enabled, defaults are `Asia/Shanghai` at `00:00`, `08:00`, and `16:00`.
- A Window covers a closed historical interval `[start, end)` only. Never create the current unfinished interval.
- Store credentials nowhere except existing encrypted local secret stores; never emit them in an error, report, event, or SSE payload.
- One in-process scheduler supports the local single-process product. Its ledger must prevent duplicate active attempts.
- Publish a degraded Window when at least one repository succeeds; fail only when none does.
- Do not add DingTalk, outbound notification delivery, distributed locking, or synthetic timeline data.
- Run every test command with `VIGIL_CONFIG_DIR=$(mktemp -d)` so the running instance's real GitHub token cannot affect test expectations.
- Keep the existing user-owned `package-lock.json` formatting change out of the staged diff while adding Luxon's lockfile entry.

---

## File structure

- `server/config.js` — normalize and persist `windowSchedule` alongside the established analysis settings.
- `server/window-schedule.js` — pure Luxon timezone validation, canonical slot normalization, and completed-range discovery.
- `server/window-store.js` — atomic window ledger, claim/retry semantics, persisted events, and artifact read/write helpers.
- `server/window-events.js` — in-memory subscription hub that forwards only persisted, sanitized events to SSE clients.
- `server/window-reports.js` — deterministic aggregate report and Window JSON/Markdown artifact formatting.
- `server/window-runner.js` — bounded-concurrency repository pipeline, provider fallback, outcomes, and event emission.
- `server/window-scheduler.js` — startup recovery, catch-up scan, retry scheduling, and next-boundary timer.
- `server/index.js` — Window APIs, SSE transport, server lifecycle startup, and status wiring.
- `server/system-status.js` — actual schedule/next-run/current-run information instead of hard-coded on-demand status.
- `server/provider.js` — provider-backed aggregate summary with bounded inputs.
- `src/api.js` — archive, Window detail, manual retry, and EventSource client functions.
- `src/App.jsx` — schedule settings editor and Window Rail/archive/detail/drawer components.
- `src/styles.css` — responsive rail, event markers, archive, status, and drawer styles based on real state.
- `test/window-schedule.test.js`, `test/window-store.test.js`, `test/window-runner.test.js`, `test/window-scheduler.test.js`, `test/window-events.test.js` — focused automated coverage.
- `test/config.test.js`, `test/system-status.test.js`, and existing provider tests — compatibility regression coverage.

## Task 1: Add the schedule contract and zone-aware interval math

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `server/config.js`
- Create: `server/window-schedule.js`
- Create: `test/window-schedule.test.js`
- Create: `test/config.test.js`

**Interfaces:**
- Produces `normalizeWindowSchedule(input): WindowSchedule` where `WindowSchedule` is `{ enabled, timezone, publishTimes, repositoryConcurrency, maxCatchUpWindows, maxAttempts }`.
- Produces `completedWindowRanges(schedule, now): WindowRange[]`, `nextPublishAt(schedule, now): string | null`, and `windowIdForRange(range): string`.
- Later tasks consume `WindowRange` as `{ id, rangeStart, rangeEnd, timezone, publishTime }` with UTC ISO timestamps.

- [x] **Step 1: Write the failing schedule and configuration tests**

```js
test('default schedule closes the three Shanghai windows with half-open UTC ranges', () => {
  const schedule = normalizeWindowSchedule({ enabled: true })
  const now = DateTime.fromISO('2026-07-16T08:01:00', { zone: 'Asia/Shanghai' }).toJSDate()
  const ranges = completedWindowRanges(schedule, now)
  assert.deepEqual(ranges.at(-1), {
    id: '2026-07-15T16-00-00-000Z__2026-07-16T00-00-00-000Z',
    rangeStart: '2026-07-15T16:00:00.000Z',
    rangeEnd: '2026-07-16T00:00:00.000Z',
    timezone: 'Asia/Shanghai',
    publishTime: '08:00',
  })
})

test('configuration canonicalizes times and disables scheduling by default', () => {
  assert.deepEqual(normalizeWindowSchedule({ publishTimes: ['16:00', '00:00', '16:00'] }).publishTimes, ['00:00', '16:00'])
  assert.equal(normalizeAnalysisSettings({}).windowSchedule.enabled, false)
})
```

- [x] **Step 2: Run the focused tests to prove the contract is missing**

Run: `VIGIL_CONFIG_DIR=$(mktemp -d) node --test test/window-schedule.test.js test/config.test.js`  
Expected: FAIL because `window-schedule.js` and `windowSchedule` do not exist.

- [x] **Step 3: Install Luxon and implement configuration normalization**

Run `npm install luxon@^3.7.2`. Preserve the pre-existing unstaged removal of the empty `devDependencies` object by staging only the dependency and lockfile changes introduced for Luxon.

Add this default to `defaultAnalysisSettings`:

```js
windowSchedule: {
  enabled: false,
  timezone: 'Asia/Shanghai',
  publishTimes: ['00:00', '08:00', '16:00'],
  repositoryConcurrency: 3,
  maxCatchUpWindows: 12,
  maxAttempts: 3,
},
```

`normalizeWindowSchedule` must use `DateTime.now().setZone(timezone).isValid` to validate an IANA zone; use the default zone if invalid. Parse only exact `HH:mm` strings, fall back to the default schedule if no valid times remain, sort distinct minutes ascending, and clamp numeric fields to `1..8`, `1..96`, and `1..5` respectively. `normalizeAnalysisSettings` calls it with `input.windowSchedule` and `saveAnalysisSettings` returns the normalized value.

Implement `completedWindowRanges` by deriving enough local calendar days to cover `maxCatchUpWindows`, retaining boundaries whose instant is `<= now`, then returning ranges between adjacent boundaries. `nextPublishAt` selects the first publication boundary strictly after `now`. Convert every boundary to UTC ISO after derivation, and generate `windowIdForRange` by replacing `:` and `.` with `-` in both timestamps joined by `__`.

- [x] **Step 4: Run focused tests and the current suite**

Run: `VIGIL_CONFIG_DIR=$(mktemp -d) node --test test/window-schedule.test.js test/config.test.js`  
Expected: PASS.

Run: `VIGIL_CONFIG_DIR=$(mktemp -d) npm test`  
Expected: PASS; existing configuration behavior is retained with scheduling disabled by default.

- [x] **Step 5: Commit the schedule contract**

```bash
git add package.json server/config.js server/window-schedule.js test/window-schedule.test.js test/config.test.js
# Stage only Luxon's dependency and package-lock resolution; leave the user's unrelated lockfile formatting change unstaged.
git commit -m "feat: add timezone-aware window schedule"
```

## Task 2: Create a durable ledger, artifact store, and event hub

**Files:**
- Create: `server/window-store.js`
- Create: `server/window-events.js`
- Create: `server/window-reports.js`
- Create: `test/window-store.test.js`
- Create: `test/window-events.test.js`

**Interfaces:**
- Consumes `WindowRange` from Task 1.
- Produces `createWindowStore(settings)` with `list`, `load`, `claim`, `appendEvent`, `finish`, `recoverStaleRuns`, and `retry` methods.
- Produces `createWindowEventHub()` with `subscribe(windowId, listener)` and `publish(event)`.
- Produces `persistWindowReport(settings, record, report)` and `loadWindowArtifact(settings, id, format)`.

- [x] **Step 1: Write failing ledger, artifact, and event tests**

```js
test('only one concurrent claim can move one Window into running state', async () => {
  const store = createWindowStore(settings)
  const [first, second] = await Promise.all([store.claim(range), store.claim(range)])
  assert.equal(first.status, 'running')
  assert.equal(second, null)
})

test('persisted events replay in sequence without secret fields', async () => {
  const stored = await store.appendEvent(range.id, { type: 'repository.collect.failed', message: 'GitHub 403', token: 'must-not-persist' })
  assert.equal(stored.sequence, 1)
  assert.equal('token' in stored, false)
  assert.deepEqual((await store.load(range.id)).events, [stored])
})

test('a hub subscriber receives newly appended events and can unsubscribe', () => {
  const hub = createWindowEventHub()
  const received = []
  const unsubscribe = hub.subscribe('window-1', (event) => received.push(event))
  hub.publish({ windowId: 'window-1', sequence: 1, type: 'window.started' })
  unsubscribe()
  hub.publish({ windowId: 'window-1', sequence: 2, type: 'window.published' })
  assert.deepEqual(received.map((event) => event.type), ['window.started'])
})
```

- [x] **Step 2: Run the focused tests to prove store and hub are absent**

Run: `VIGIL_CONFIG_DIR=$(mktemp -d) node --test test/window-store.test.js test/window-events.test.js`  
Expected: FAIL with module-not-found errors.

- [x] **Step 3: Implement atomic ledger and report persistence**

Use an internal promise mutation queue plus temp-file-and-rename writes at `<workspace>/window-runs.json`, matching `server/repository-store.js`. Store `{ version: 1, windows: [] }` and keep records newest-first for listing while events remain sequence-ordered inside each record.

Implement safe event normalization to retain only `windowId`, monotonically assigned `sequence`, ISO `at`, `type`, optional `repositoryId`, `repository`, `stage`, `message`, `status`, and non-negative integer `elapsedMs`. Convert errors to `String(error.message || error).slice(0, 600)` and omit all unrecognized keys.

`claim(range, repositories, now)` creates a queued record when needed, then atomically returns it in `running` state only if it is queued or failed with a due retry. Records in running or terminal successful states return `null`. `recoverStaleRuns(now)` changes persisted `running` records to queued with a `window.recovered` event. `retry(id, now)` only changes terminal `failed` records to queued, clears `nextRetryAt`, and appends `window.retry.queued`.

Write `window.json` and `window.md` at `<workspace>/artifacts/windows/<id>/` with permissions `0600`, and create parent directories at `0700`. The Markdown includes Window range, status, repository outcomes, generated time, analysis mode, and aggregate Markdown. Artifact reads return `null` only for `ENOENT`; all other filesystem errors propagate.

- [x] **Step 4: Implement the event hub and validate tests**

Maintain a `Map<windowId, Set<listener>>`. `publish` calls each listener synchronously and catches listener exceptions so one disconnected SSE client cannot affect the runner. `subscribe` returns a stable cleanup function.

Run: `VIGIL_CONFIG_DIR=$(mktemp -d) node --test test/window-store.test.js test/window-events.test.js`  
Expected: PASS.

- [x] **Step 5: Commit the durable Window primitives**

```bash
git add server/window-store.js server/window-events.js server/window-reports.js test/window-store.test.js test/window-events.test.js
git commit -m "feat: persist window runs and timeline events"
```

## Task 3: Implement isolated repository execution and aggregate publication

**Files:**
- Modify: `server/provider.js`
- Create: `server/window-runner.js`
- Create: `test/window-runner.test.js`
- Modify: `test/provider.test.js`

**Interfaces:**
- Consumes the store and event hub from Task 2, plus `collectSourceWindow`, `syncFullRepository`, `persistRepositorySummary`, and provider status from existing modules.
- Produces `createWindowRunner({ store, events, now, collect, sync, summarize, persistSummary, aggregate })` with `run(range, settings, repositories)`.
- Produces `executeWindowSummary(settings, input)` returning `{ mode, content, model, usage, latencyMs }`.

- [x] **Step 1: Write failing runner tests using injected repository adapters**

```js
test('a Window publishes degraded after one repository fails and one succeeds', async () => {
  const runner = createWindowRunner({ store, events, collect: async (_settings, source) => {
    if (source.id === 'bad') throw new Error('remote unavailable')
    return snapshotFor(source)
  }, sync: async () => ({ syncedAt: '2026-07-16T08:00:01.000Z' }), summarize: async () => ({ mode: 'structured', content: 'repo summary' }), persistSummary: async () => ({ artifactId: 'good/report' }), aggregate: async () => ({ mode: 'structured', content: 'window summary' }) })
  const result = await runner.run(range, settings, [{ id: 'good', syncMode: 'on-demand' }, { id: 'bad', syncMode: 'on-demand' }])
  assert.equal(result.status, 'degraded')
  assert.equal(result.repositoryRuns.filter((item) => item.status === 'succeeded').length, 1)
  assert.equal(result.repositoryRuns.filter((item) => item.status === 'failed').length, 1)
  assert.equal(result.events.at(-1).type, 'window.degraded')
})

test('a Window fails and schedules a retry when every repository fails', async () => {
  const result = await runner.run(range, settings, [{ id: 'bad', syncMode: 'full' }])
  assert.equal(result.status, 'failed')
  assert.equal(result.attempt, 1)
  assert.equal(result.nextRetryAt, '2026-07-16T08:05:00.000Z')
})
```

- [x] **Step 2: Run the runner test to prove the pipeline is absent**

Run: `VIGIL_CONFIG_DIR=$(mktemp -d) node --test test/window-runner.test.js`  
Expected: FAIL because `createWindowRunner` does not exist.

- [x] **Step 3: Add bounded provider aggregation and deterministic fallback**

Add `executeWindowSummary(settings, input)` in `server/provider.js`. Send the provider only `{ range, timezone, repositories: repositoryRuns.map(({ repository, snapshot, report }) => ({ repository, counts: snapshot.counts, hotPullRequests: snapshot.hotPullRequests.slice(0, 5), analysis: report.analysis.content.slice(0, 6000) })) }`; this bounds prompt size and prevents accidental secret transit.

Add `structuredWindowSummary(window)` in `server/window-reports.js`. It must list the interval, successful/failed repository counts, each successful repository's commit/PR/issue/release counts, and failed repository messages. It uses no provider and always returns `mode: 'structured'`.

- [x] **Step 4: Implement the runner and passing cases**

`run` must claim before doing network work; return the existing record when no claim is available. Snapshot the input watchlist at claim time. Use a small worker pool whose width is `settings.windowSchedule.repositoryConcurrency`; every repository job emits stage-start and stage-completion/failure events through `store.appendEvent` followed by `events.publish`.

For a full-sync watch call existing `syncFullRepository`; update its local sync fields with `updateWatchedRepository` only on a successful sync. For on-demand watches emit `repository.sync.succeeded` with `stage: 'metadata'` without invoking Git. Collect the exact `rangeStart`/`rangeEnd` converted to the existing `{ from, to }` range. Create the report using structured summary, replace it with provider output only when `providerCredentialStatus(settings).providerReady`, and retain `analysisError` plus the structured result if provider execution fails.

Use `Promise.allSettled` semantics inside each repository unit so all jobs finish. A run with successes persists an aggregate artifact and finishes `published` or `degraded`; a no-success run finishes `failed` and sets `nextRetryAt` to `now + 5 * 60 * 1000 * 2 ** (attempt - 1)` while attempts remain. Emit the terminal event only after the record and artifact are durable.

- [x] **Step 5: Run focused and regression tests**

Run: `VIGIL_CONFIG_DIR=$(mktemp -d) node --test test/window-runner.test.js test/provider.test.js test/reports.test.js`  
Expected: PASS.

Run: `VIGIL_CONFIG_DIR=$(mktemp -d) npm test`  
Expected: PASS.

- [x] **Step 6: Commit the execution pipeline**

```bash
git add server/provider.js server/window-runner.js server/window-reports.js test/window-runner.test.js test/provider.test.js
git commit -m "feat: publish repository intelligence windows"
```

## Task 4: Start the scheduler and expose truthful API/status state

**Files:**
- Create: `server/window-scheduler.js`
- Modify: `server/system-status.js`
- Modify: `server/index.js`
- Create: `test/window-scheduler.test.js`
- Modify: `test/system-status.test.js`

**Interfaces:**
- Consumes `completedWindowRanges`, `nextPublishAt`, `createWindowRunner`, and `createWindowStore`.
- Produces `createWindowScheduler({ loadSettings, loadRepositories, runner, store, now, timers })` with `start`, `stop`, `scan`, `trigger`, and `status`.
- Produces REST handlers at `/api/windows`, `/api/windows/:id`, `/api/windows/:id/events`, `/api/windows/:id/download`, `/api/windows/trigger`, and `/api/windows/:id/retry`.

- [x] **Step 1: Write failing recovery and status tests**

```js
test('startup scans closed missed ranges but never creates the current in-progress Window', async () => {
  const scheduler = createWindowScheduler({ loadSettings: async () => enabledSettings, loadRepositories: async () => repositories, runner, store, now: () => new Date('2026-07-16T08:01:00.000Z'), timers })
  await scheduler.start()
  assert.deepEqual(runner.ranges.map((range) => range.rangeEnd), ['2026-07-16T08:00:00.000Z'])
})

test('status describes enabled schedule and live Window rather than on-demand collection', async () => {
  const status = await collectSystemStatus(enabledSettings, [], process.env, { nextPublishAt: '2026-07-16T08:00:00.000Z', currentRun: { id: 'window-1', status: 'running' } })
  assert.equal(status.collection.mode, 'scheduled')
  assert.equal(status.collection.scheduled, true)
  assert.equal(status.collection.currentWindow.status, 'running')
})
```

- [x] **Step 2: Run tests to prove scheduler behavior is absent**

Run: `VIGIL_CONFIG_DIR=$(mktemp -d) node --test test/window-scheduler.test.js test/system-status.test.js`  
Expected: FAIL with module or status contract errors.

- [x] **Step 3: Implement lifecycle, recovery, and timer behavior**

`start` is idempotent. When schedule is disabled it cancels timers and reports no next run. When enabled it calls `store.recoverStaleRuns`, scans closed ranges in ascending order limited by `maxCatchUpWindows`, starts eligible pending/retry runs without awaiting the complete background batch, then arms exactly one timeout for the next boundary. The timeout calls `scan` and re-arms in `finally`. `stop` clears the active timer and prevents future re-arms.

`trigger` accepts an optional ISO `rangeEnd`; it derives the matching completed range and rejects a non-closed/current range with a 400-safe error. `retry` calls the ledger's terminal-failure retry and invokes the runner. All API mutation endpoints are automatically administrator-only by the existing `/api` middleware.

`GET /api/windows` returns `{ windows, scheduler }`; `GET /api/windows/:id` returns `404` when absent. The SSE handler sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and `Connection: keep-alive`, writes every persisted event before subscribing, sends `event: window` with `data: <JSON>`, unsubscribes on close, and emits a comment heartbeat every 25 seconds. Downloads use the artifact helper, set safe filenames, and return 404 for missing reports.

Instantiate a shared store, event hub, runner, and scheduler once in `server/index.js`; call `await scheduler.start()` after bootstrap initialization, and pass `scheduler.status()` into `collectSystemStatus`.

- [x] **Step 4: Update system status and run tests**

`collectSystemStatus` accepts an optional scheduler state and returns `collection: { mode: settings.windowSchedule.enabled ? 'scheduled' : 'on-demand', scheduled, timezone, publishTimes, nextPublishAt, currentWindow, lastWindow, ...existingCredentials }`. Keep disabled defaults compatible with the current UI.

Run: `VIGIL_CONFIG_DIR=$(mktemp -d) node --test test/window-scheduler.test.js test/system-status.test.js`  
Expected: PASS.

Run: `VIGIL_CONFIG_DIR=$(mktemp -d) npm test`  
Expected: PASS.

- [x] **Step 5: Commit scheduler and API surface**

```bash
git add server/window-scheduler.js server/system-status.js server/index.js test/window-scheduler.test.js test/system-status.test.js
git commit -m "feat: schedule and stream repository windows"
```

## Task 5: Build the admin schedule controls and primary Window Rail

**Files:**
- Modify: `src/api.js`
- Modify: `src/App.jsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes `GET /api/windows` and Window records from Task 4.
- Produces `getWindows`, `getWindow`, `windowDownloadUrl`, `triggerWindow`, `retryWindow`, and `subscribeToWindowEvents` API helpers.
- Produces React components `WindowsView`, `WindowRail`, `WindowArchive`, and `WindowEventDrawer`.

- [x] **Step 1: Add API functions and a reconnect-safe SSE helper**

```js
export function getWindows() { return request('/api/windows') }
export function getWindow(id) { return request(`/api/windows/${encodeURIComponent(id)}`) }
export function retryWindow(id) { return request(`/api/windows/${encodeURIComponent(id)}/retry`, { method: 'POST' }) }
export function windowDownloadUrl(id, format = 'markdown') { return `/api/windows/${encodeURIComponent(id)}/download?format=${format === 'json' ? 'json' : 'markdown'}` }
export function subscribeToWindowEvents(id, onEvent) {
  const source = new EventSource(`/api/windows/${encodeURIComponent(id)}/events`)
  source.addEventListener('window', (event) => onEvent(JSON.parse(event.data)))
  return () => source.close()
}
```

`WindowsView` loads the archive on mount, selects the running Window first or the latest archive, opens SSE only for a selected `queued`/`running` Window, and merges incoming events by `sequence` to make reconnect replay harmless. Refresh the selected record after every terminal event. Show a real empty state only when the API has no persisted Windows.

- [x] **Step 2: Replace the empty page with the primary rail and detail drawer**

Render archive rows from actual records showing local-time range, `published`/`degraded`/`failed` status, repository success/failure counts, and selection. Render the primary rail as event markers along an interval axis, with the true current time marker only for an active Window. Every marker opens `WindowEventDrawer`, which shows timestamp, stage, repository, elapsed time, safe message, and report link. Do not render invented progress counts or signals.

Show aggregate Markdown using the existing `MarkdownReport`; expose JSON/Markdown download links only if an artifact exists. A failed Window shows an administrator retry control, but does not auto-retry after its persisted `maxAttempts` is reached.

Add a `Window schedule` panel to `AnalysisSettings` that edits `enabled`, `timezone`, comma-separated `publishTimes`, `repositoryConcurrency`, `maxCatchUpWindows`, and `maxAttempts` inside existing settings. Convert the text list to trimmed `HH:mm` candidates before save; always use returned server-normalized settings after save.

Update `SystemStatus` to read actual `status.collection`: show enabled/disabled, timezone and slots, next boundary, and live Window state instead of the fixed `on demand · scheduled ingestion disabled` copy.

- [x] **Step 3: Add responsive styles that preserve the established visual language**

Add styles for `.window-shell`, `.window-rail`, `.rail-axis`, `.rail-event`, `.rail-event.failed`, `.rail-now`, `.window-event-drawer`, `.window-summary-grid`, and `.schedule-settings`. Use the current ink/paper/acid variables, minimum 44px interactive targets, keyboard-focus outlines, and an `@media (prefers-reduced-motion: reduce)` block that removes rail fall-in and pulse animation. Reuse existing status-pill styles and add `degraded` as a visible warning state.

- [x] **Step 4: Build and inspect the production bundle**

Run: `npm run build`  
Expected: PASS. Existing Vite chunk-size warnings are informational unless a build error is present.

- [x] **Step 5: Commit the Window Rail UI**

```bash
git add src/api.js src/App.jsx src/styles.css
git commit -m "feat: add live window rail interface"
```

## Task 6: End-to-end verification, documentation, commit review, and push

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-16-scheduled-window-timeline.md` (check completed tasks)

**Interfaces:**
- Consumes all implementation tasks.
- Produces a verified localhost run, a user-facing schedule section, and a pushed `main` branch.

- [x] **Step 1: Document use and operational limits**

Replace the README statement that scheduled Window publishing is only a future boundary with a concise usage section: configure a GitHub/Gerrit watch, set provider credentials if semantic reports are desired, enable the Window schedule in Admin, default publication times, restart catch-up behavior, degraded outcome semantics, the local-single-process limitation, and the explicit absence of DingTalk notifications.

- [x] **Step 2: Run all automated checks from isolation**

Run: `VIGIL_CONFIG_DIR=$(mktemp -d) npm test`  
Expected: all test files pass.

Run: `npm run build`  
Expected: successful production bundle.

Run: `git diff --check`  
Expected: no whitespace errors in staged implementation.

- [x] **Step 3: Verify the running local service and browser path**

Start or use `VIGIL_PORT=8787 npm run dev:api` and the Vite UI. Authenticate as the local administrator, configure a temporary workspace and a schedule, add a safe public watch, then invoke one closed historical Window through `POST /api/windows/trigger`. Verify:

1. `GET /api/windows` lists the created record;
2. `GET /api/windows/:id/events` replays ordered persisted `window` SSE events;
3. `GET /api/windows/:id/download?format=markdown` returns the report;
4. the Window Rail renders actual events and the drawer details; and
5. `<workspace>/artifacts/windows/<id>/window.json` and `window.md` exist.

Use a short historic range and the existing configured public project. If remote collection cannot complete because external credentials or network are unavailable, verify the fully persisted `failed` result, event replay, retry control, and artifacts; this is an expected pipeline outcome, not a substitute for the automated successful/degraded tests.

- [x] **Step 4: Review completion and commit documentation**

Compare implementation against every acceptance criterion in `docs/superpowers/specs/2026-07-16-scheduled-window-timeline-design.md`: default schedule, exact range math, no early Window, catch-up, duplicate prevention, per-repository isolation, degraded publication, durable safe events/artifacts, SSE replay, real UI data, and no DingTalk code. Check every plan task checkbox only after its evidence has passed.

```bash
git add README.md docs/superpowers/plans/2026-07-16-scheduled-window-timeline.md
git commit -m "docs: explain scheduled window publishing"
git status --short
git log --oneline origin/main..HEAD
git push origin main
```

Expected: only intended commits are ahead of `origin/main`; the user-owned `package-lock.json` formatting change and `.superpowers/` remain unstaged. If the index's Luxon lockfile entry was committed in Task 1, this final status may show the user formatting edit as an unstaged `M package-lock.json` and that is intentional.
