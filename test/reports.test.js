import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadRepositorySummary, persistRepositorySummary, structuredRepositorySummary } from '../server/reports.js'

test('repository reports persist and load by exact repository and time range', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'vigil-report-'))
  const settings = { workspace: { directory: workspace } }
  const snapshot = {
    repository: 'owner/repository',
    range: { from: '2026-07-16T00:00:00.000Z', to: '2026-07-16T08:00:00.000Z' },
    counts: { commits: 1, pullRequests: 1, issues: 0, releases: 0 },
    commits: [{ sha: 'abc123', message: 'Change scheduler', url: 'https://example.test/commit' }],
    hotPullRequests: [{ number: 42, title: 'Hot PR', url: 'https://example.test/pr', hotScore: 91 }],
    issues: [],
    releases: [],
  }
  const report = {
    snapshot,
    analysis: structuredRepositorySummary(snapshot),
    generatedAt: '2026-07-16T08:10:00.000Z',
  }

  const paths = await persistRepositorySummary(settings, report)
  const loaded = await loadRepositorySummary(settings, snapshot.repository, snapshot.range)

  assert.deepEqual(loaded.report, report)
  assert.equal(loaded.artifactId, paths.artifactId)
  assert.match(await readFile(paths.markdownPath, 'utf8'), /Repository Intelligence Report/)
  await rm(workspace, { recursive: true, force: true })
})

test('different time boundaries do not reuse a repository report', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'vigil-report-'))
  const missing = await loadRepositorySummary(
    { workspace: { directory: workspace } },
    'owner/repository',
    { from: '2026-07-16T00:00:00.000Z', to: '2026-07-16T08:00:01.000Z' },
  )
  assert.equal(missing, null)
  await rm(workspace, { recursive: true, force: true })
})
