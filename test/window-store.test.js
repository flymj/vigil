import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { persistWindowReport } from '../server/window-reports.js'
import { createWindowStore } from '../server/window-store.js'

const range = {
  id: '2026-07-15T16-00-00-000Z__2026-07-16T00-00-00-000Z',
  rangeStart: '2026-07-15T16:00:00.000Z',
  rangeEnd: '2026-07-16T00:00:00.000Z',
  timezone: 'Asia/Shanghai',
  publishTime: '08:00',
}

async function withWorkspace(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vigil-window-store-'))
  try {
    await run({ workspace: { directory } })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('only one concurrent claim can move one Window into running state', async () => {
  await withWorkspace(async (settings) => {
    const store = createWindowStore(settings)
    const repositories = [{ id: 'good', project: 'openai/example', sourceType: 'github', syncMode: 'on-demand' }]
    const [first, second] = await Promise.all([
      store.claim(range, repositories, new Date('2026-07-16T00:01:00.000Z')),
      store.claim(range, repositories, new Date('2026-07-16T00:01:00.000Z')),
    ])

    assert.equal(first.status, 'running')
    assert.equal(first.attempt, 1)
    assert.equal(second, null)
    assert.deepEqual((await store.load(range.id)).repositories, repositories)
    assert.deepEqual((await store.load(range.id)).events.map((event) => event.type), ['window.queued'])
  })
})

test('persisted events receive a sequence and omit unrecognized secret fields', async () => {
  await withWorkspace(async (settings) => {
    const store = createWindowStore(settings)
    await store.claim(range, [], new Date('2026-07-16T00:01:00.000Z'))
    const stored = await store.appendEvent(range.id, {
      type: 'repository.collect.failed',
      repository: 'openai/example',
      message: 'GitHub 403',
      elapsedMs: 19,
      token: 'must-not-persist',
      authorization: 'must-not-persist',
    }, new Date('2026-07-16T00:01:01.000Z'))

    assert.equal(stored.sequence, 2)
    assert.equal('token' in stored, false)
    assert.equal('authorization' in stored, false)
    assert.deepEqual((await store.load(range.id)).events.map((event) => event.type), ['window.queued', stored.type])
  })
})

test('startup recovery returns a stale running Window to the durable queue', async () => {
  await withWorkspace(async (settings) => {
    const store = createWindowStore(settings)
    await store.claim(range, [], new Date('2026-07-16T00:01:00.000Z'))
    const recovered = await store.recoverStaleRuns(new Date('2026-07-16T00:02:00.000Z'))

    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].status, 'queued')
    assert.equal(recovered[0].events.at(-1).type, 'window.recovered')
    const claimedAgain = await store.claim(range, [], new Date('2026-07-16T00:03:00.000Z'))
    assert.equal(claimedAgain.attempt, 2)
  })
})

test('Window artifacts preserve the aggregate report outside the ledger', async () => {
  await withWorkspace(async (settings) => {
    const record = {
      ...range,
      status: 'degraded',
      finishedAt: '2026-07-16T00:02:00.000Z',
      repositoryRuns: [
        { repositoryId: 'good', repository: 'openai/example', status: 'succeeded', counts: { commits: 2, pullRequests: 1, issues: 0, releases: 0 } },
        { repositoryId: 'bad', repository: 'openai/broken', status: 'failed', error: 'remote unavailable' },
      ],
    }
    const report = { generatedAt: '2026-07-16T00:02:00.000Z', analysis: { mode: 'structured', content: '真实 Window 报告' } }
    const paths = await persistWindowReport(settings, record, report)
    const markdown = await readFile(paths.markdownPath, 'utf8')

    assert.equal(paths.artifactId, range.id)
    assert.match(markdown, /真实 Window 报告/)
    assert.match(markdown, /openai\/broken/)
  })
})
