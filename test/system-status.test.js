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
    github: { tokenEnv: 'TEST_GITHUB_TOKEN' },
    gerrit: { usernameEnv: 'TEST_GERRIT_USER', passwordEnv: 'TEST_GERRIT_PASSWORD' },
    provider: { name: 'Local provider', baseUrl: 'http://127.0.0.1:9000/v1', model: 'test-model', requiresApiKey: true },
  }
  const repositories = [
    { sourceType: 'github', syncMode: 'full', syncStatus: 'ready' },
    { sourceType: 'gerrit', syncMode: 'full', syncStatus: 'failed' },
  ]

  try {
    const status = await collectSystemStatus(settings, repositories, {
      TEST_GITHUB_TOKEN: 'configured',
      TEST_GERRIT_USER: 'configured',
    })
    assert.equal(status.workspace.available, true)
    assert.deepEqual(status.repositories, { total: 2, github: 1, gerrit: 1, fullSyncReady: 1, fullSyncFailed: 1 })
    assert.equal(status.collection.mode, 'on-demand')
    assert.equal(status.collection.scheduled, false)
    assert.equal(status.collection.githubTokenConfigured, true)
    assert.equal(status.collection.gerritCredentialsConfigured, false)
    assert.equal(status.provider.credentialConfigured, false)
    assert.equal(status.authentication.configured, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
