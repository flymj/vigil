import { copyFile, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { normalizeAnalysisSettings } from '../server/config.js'
import { createDreamRunner } from '../server/dream-runner.js'
import { closedDailyHorizons } from '../server/dream-schedule.js'
import { createDreamStore } from '../server/dream-store.js'
import { createWindowEventHub } from '../server/window-events.js'
import { createWindowRunner } from '../server/window-runner.js'
import { windowIdForRange } from '../server/window-schedule.js'
import { createWindowStore } from '../server/window-store.js'

const targetConfig = process.env.VIGIL_CONFIG_DIR
const sourceConfig = process.env.VIGIL_ACCEPTANCE_SOURCE_CONFIG
const acceptanceRoot = process.env.VIGIL_ACCEPTANCE_ROOT
if (!targetConfig || !sourceConfig || !acceptanceRoot) {
  throw new Error('Set VIGIL_CONFIG_DIR, VIGIL_ACCEPTANCE_SOURCE_CONFIG, and VIGIL_ACCEPTANCE_ROOT')
}
const resolvedRoot = path.resolve(acceptanceRoot)
const resolvedTargetConfig = path.resolve(targetConfig)
const resolvedSourceConfig = path.resolve(sourceConfig)
const targetRelative = path.relative(resolvedRoot, resolvedTargetConfig)
if (resolvedTargetConfig === resolvedSourceConfig) throw new Error('Acceptance config must not be the live source config')
if (!path.basename(resolvedRoot).startsWith('vigil-dream-acceptance.')) throw new Error('Acceptance root must be a dedicated vigil-dream-acceptance.* temporary directory')
if (!targetRelative || targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) throw new Error('Acceptance config must be inside the dedicated acceptance root')
if (!path.relative(resolvedRoot, resolvedSourceConfig).startsWith('..')) throw new Error('Live source config must be outside the disposable acceptance root')

const workspace = path.join(acceptanceRoot, 'workspace')
const credentialFiles = ['provider-secret.json', 'provider-secret.key', 'github-secret.json', 'github-secret.key']
const keep = process.env.VIGIL_ACCEPTANCE_KEEP === '1'
let inspectionSettings = null

async function scrubCopiedCredentials() {
  for (const filename of credentialFiles) {
    try { await unlink(path.join(targetConfig, filename)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

try {
  await mkdir(targetConfig, { recursive: true, mode: 0o700 })
  await mkdir(workspace, { recursive: true, mode: 0o700 })

  const sourceSettings = JSON.parse(await readFile(path.join(sourceConfig, 'analysis.json'), 'utf8'))
  const sourceWorkspace = sourceSettings.workspace.directory
  const watchlist = JSON.parse(await readFile(path.join(sourceWorkspace, 'watchlist.json'), 'utf8'))
  const repositories = (watchlist.repositories || []).slice(0, 1).map((repository) => ({
    ...repository,
    syncMode: 'on-demand',
    syncStatus: 'on-demand',
    localPath: '',
  }))
  if (!repositories.length) throw new Error('Local acceptance requires at least one watched repository')

  for (const filename of credentialFiles) {
    try { await copyFile(path.join(sourceConfig, filename), path.join(targetConfig, filename)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }

  const settings = normalizeAnalysisSettings({
    ...sourceSettings,
    workspace: { directory: workspace },
    windowSchedule: {
      enabled: true,
      timezone: 'Asia/Shanghai',
      publishTimes: ['00:00', '08:00', '16:00'],
      repositoryConcurrency: 1,
      maxCatchUpWindows: 12,
      maxAttempts: 1,
    },
    dreamSchedule: {
      enabled: true,
      timezone: 'Asia/Shanghai',
      publishDelayMinutes: 0,
      maxCatchUpDays: 2,
      maxAttempts: 1,
      leaseSeconds: 900,
      maxCandidates: 2,
      maxEvidenceRequests: 1,
      maxSignalChanges: 1,
      maxTopicChanges: 1,
      scoutMaxOutputTokens: 4000,
      maxOutputTokens: 16000,
      contextMaxChars: 180000,
    },
  })
  inspectionSettings = settings
  await writeFile(path.join(targetConfig, 'analysis.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  await writeFile(path.join(workspace, 'watchlist.json'), `${JSON.stringify({ version: 1, repositories }, null, 2)}\n`, { mode: 0o600 })

  const horizon = closedDailyHorizons(settings.dreamSchedule, new Date()).at(-1)
  const range = {
    rangeStart: horizon.start,
    rangeEnd: horizon.end,
    timezone: horizon.timezone,
    publishTime: '00:00',
  }
  range.id = windowIdForRange(range)

  const windowStore = createWindowStore(settings)
  const windowRunner = createWindowRunner({
    store: windowStore,
    events: createWindowEventHub(),
    providerStatus: async () => ({ providerReady: false }),
  })
  const window = await windowRunner.run(range, settings, repositories)
  if (!['published', 'degraded'].includes(window.status)) throw new Error(`Acceptance Window did not publish: ${window.error || window.status}`)

  const dreamStore = createDreamStore(settings)
  try {
    const runner = createDreamRunner({ store: dreamStore, windowStore })
    const first = await runner.run(horizon, settings, repositories)
    const second = first.status === 'accepted' ? await runner.run(horizon, settings, repositories) : null
    const signals = dreamStore.listSignals({ limit: 10 })
    const topics = dreamStore.listTopics({ limit: 10 })
    const result = {
      acceptanceRoot,
      configDirectory: targetConfig,
      workspace,
      source: repositories.map(({ sourceType, host, project, branch }) => ({ sourceType, host, project, branch })),
      horizon,
      window: {
        id: window.id,
        status: window.status,
        repositoryRuns: window.repositoryRuns.map(({ repository, status, counts }) => ({ repository, status, counts })),
      },
      dream: {
        id: first.id,
        status: first.status,
        outcome: first.outcome,
        stage: first.stage,
        diagnostics: first.diagnostics,
        idempotentReplay: second ? { id: second.id, status: second.status, attempt: second.attempt, sameRun: second.id === first.id } : null,
      },
      signals: signals.items.map(({ id, title, status, evidenceCount, topicCount }) => ({ id, title, status, evidenceCount, topicCount })),
      topics: topics.items.map(({ id, title, status, evidenceCount, signalCount }) => ({ id, title, status, evidenceCount, signalCount })),
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    dreamStore.close()
  }
} finally {
  await scrubCopiedCredentials()
  if (keep && inspectionSettings) {
    const safeInspectionSettings = { ...inspectionSettings, provider: { ...inspectionSettings.provider, requiresApiKey: false } }
    await writeFile(path.join(targetConfig, 'analysis.json'), `${JSON.stringify(safeInspectionSettings, null, 2)}\n`, { mode: 0o600 })
  }
  if (!keep) await rm(resolvedRoot, { recursive: true, force: true })
}
