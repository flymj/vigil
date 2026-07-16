import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createWindowEventHub } from '../server/window-events.js'
import { createWindowRunner } from '../server/window-runner.js'
import { createWindowStore } from '../server/window-store.js'

const range = {
  id: '2026-07-15T16-00-00-000Z__2026-07-16T00-00-00-000Z',
  rangeStart: '2026-07-15T16:00:00.000Z',
  rangeEnd: '2026-07-16T00:00:00.000Z',
  timezone: 'Asia/Shanghai',
  publishTime: '08:00',
}

function snapshotFor(repository) {
  return {
    repository: repository.project,
    repositoryKey: repository.id,
    sourceType: repository.sourceType,
    branch: repository.branch,
    range: { from: range.rangeStart, to: range.rangeEnd },
    counts: { commits: 2, pullRequests: 1, issues: 0, releases: 0 },
    commits: [{ message: 'Add real Window evidence' }],
    hotPullRequests: [],
    issues: [],
    releases: [],
  }
}

async function withRunner(run, windowSchedule = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vigil-window-runner-'))
  const settings = {
    workspace: { directory },
    provider: { requiresApiKey: false },
    windowSchedule: { repositoryConcurrency: 2, maxAttempts: 3, ...windowSchedule },
  }
  const store = createWindowStore(settings)
  const events = createWindowEventHub()
  try {
    await run({ settings, store, events })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('a Window publishes degraded after one repository fails and one succeeds', async () => {
  await withRunner(async ({ settings, store, events }) => {
    const runner = createWindowRunner({
      store,
      events,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
      collect: async (_settings, repository) => {
        if (repository.id === 'bad') throw new Error('remote unavailable')
        return snapshotFor(repository)
      },
      providerStatus: async () => ({ providerReady: false }),
      persistSummary: async () => ({ artifactId: 'good/report' }),
      updateRepository: async () => {},
    })
    const result = await runner.run(range, settings, [
      { id: 'good', project: 'openai/good', sourceType: 'github', branch: 'main', syncMode: 'on-demand' },
      { id: 'bad', project: 'openai/bad', sourceType: 'github', branch: 'main', syncMode: 'on-demand' },
    ])

    assert.equal(result.status, 'degraded')
    assert.equal(result.repositoryRuns.filter((item) => item.status === 'succeeded').length, 1)
    assert.equal(result.repositoryRuns.filter((item) => item.status === 'failed').length, 1)
    assert.equal(result.events.at(-1).type, 'window.degraded')
  })
})

test('a Window fails and schedules a retry when every repository fails', async () => {
  await withRunner(async ({ settings, store, events }) => {
    const runner = createWindowRunner({
      store,
      events,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
      sync: async () => { throw new Error('sync unavailable') },
      providerStatus: async () => ({ providerReady: false }),
      updateRepository: async () => {},
    })
    const result = await runner.run(range, settings, [
      { id: 'bad', project: 'openai/bad', sourceType: 'github', branch: 'main', syncMode: 'full' },
    ])

    assert.equal(result.status, 'failed')
    assert.equal(result.attempt, 1)
    assert.equal(result.nextRetryAt, '2026-07-16T00:05:00.000Z')
    assert.equal(result.events.at(-1).type, 'window.failed')
  })
})

test('a failed Window becomes terminal once it reaches its maximum attempts', async () => {
  await withRunner(async ({ settings, store, events }) => {
    const runner = createWindowRunner({
      store,
      events,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
      sync: async () => { throw new Error('sync unavailable') },
      providerStatus: async () => ({ providerReady: false }),
      updateRepository: async () => {},
    })
    const result = await runner.run(range, settings, [
      { id: 'bad', project: 'openai/bad', sourceType: 'github', branch: 'main', syncMode: 'full' },
    ])

    assert.equal(result.status, 'failed')
    assert.equal(result.nextRetryAt, null)
    assert.equal(result.events.at(-1).type, 'window.failed')
  }, { maxAttempts: 1 })
})
