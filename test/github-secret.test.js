import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const directory = await mkdtemp(path.join(os.tmpdir(), 'vigil-github-secret-'))
process.env.VIGIL_CONFIG_DIR = directory

const { githubApiKeyConfigured, loadGitHubApiKey, saveGitHubApiKey } = await import('../server/github-secret.js')

test('stores the GitHub token as local AES-GCM ciphertext and never returns it from status', async () => {
  const apiKey = 'github_pat_local_secret'
  try {
    await saveGitHubApiKey(apiKey)
    const stored = await readFile(path.join(directory, 'github-secret.json'), 'utf8')
    assert.equal(stored.includes(apiKey), false)
    assert.equal(await githubApiKeyConfigured(), true)
    assert.equal(await loadGitHubApiKey(), apiKey)

    await saveGitHubApiKey('')
    assert.equal(await githubApiKeyConfigured(), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
