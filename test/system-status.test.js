import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { collectSystemStatus } from '../server/system-status.js'

test('system status reports only observed local configuration and repository state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vigil-status-'))
  const settings = {
    workspace: { directory },
    github: {},
    gerrit: { usernameEnv: 'TEST_GERRIT_USER', passwordEnv: 'TEST_GERRIT_PASSWORD' },
    provider: { name: 'Local provider', baseUrl: 'http://127.0.0.1:9000/v1', model: 'test-model', requiresApiKey: true },
    windowSchedule: { enabled: true, timezone: 'Asia/Shanghai', publishTimes: ['00:00', '08:00', '16:00'] },
  }
  const repositories = [
    { sourceType: 'github', syncMode: 'full', syncStatus: 'ready' },
    { sourceType: 'gerrit', syncMode: 'full', syncStatus: 'failed' },
  ]

  try {
    const status = await collectSystemStatus(settings, repositories, {
      TEST_GERRIT_USER: 'configured',
    }, {
      nextPublishAt: '2026-07-16T08:00:00.000Z',
      currentRun: { id: 'window-1', status: 'running' },
      lastWindow: { id: 'window-0', status: 'published' },
    }, {
      enabled: true,
      ready: true,
      reasons: [],
      nextRunAt: '2026-07-17T16:10:00.000Z',
      lastRun: { id: 'run-1', status: 'accepted', outcome: 'no_finding' },
      cursor: '2026-07-17T16:00:00.000Z',
      versions: { signals: 1, topics: 1, evidence: 1 },
    })
    assert.equal(status.workspace.available, true)
    assert.deepEqual(status.repositories, { total: 2, github: 1, gerrit: 1, fullSyncReady: 1, fullSyncFailed: 1 })
    assert.equal(status.collection.mode, 'scheduled')
    assert.equal(status.collection.scheduled, true)
    assert.equal(status.collection.timezone, 'Asia/Shanghai')
    assert.equal(status.collection.nextPublishAt, '2026-07-16T08:00:00.000Z')
    assert.equal(status.collection.currentWindow.status, 'running')
    assert.equal(typeof status.collection.githubTokenConfigured, 'boolean')
    assert.equal(status.collection.gerritCredentialsConfigured, false)
    assert.equal(typeof status.provider.credentialConfigured, 'boolean')
    assert.equal(status.provider.ready, status.provider.endpointConfigured && (!status.provider.credentialRequired || status.provider.credentialConfigured))
    assert.equal(status.dream.ready, true)
    assert.equal(status.dream.lastRun.outcome, 'no_finding')
    assert.equal(typeof status.authentication.configured, 'boolean')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('system status treats a configured key-free provider as ready', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vigil-status-key-free-'))
  try {
    const status = await collectSystemStatus({
      workspace: { directory },
      github: {},
      gerrit: {},
      provider: { name: 'Local provider', baseUrl: 'http://127.0.0.1:9000/v1', model: 'test-model', requiresApiKey: false },
      windowSchedule: { enabled: false, timezone: 'Asia/Shanghai', publishTimes: ['00:00'] },
      dreamSchedule: { enabled: false, timezone: 'Asia/Shanghai' },
    }, [])
    assert.equal(status.provider.endpointConfigured, true)
    assert.equal(status.provider.credentialRequired, false)
    assert.equal(status.provider.ready, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
