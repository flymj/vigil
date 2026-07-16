import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const directory = await mkdtemp(path.join(os.tmpdir(), 'vigil-provider-secret-'))
process.env.VIGIL_CONFIG_DIR = directory

const { loadProviderApiKey, providerApiKeyConfigured, saveProviderApiKey } = await import('../server/provider-secret.js')

test('stores the provider API key as local AES-GCM ciphertext and never returns it from status', async () => {
  const apiKey = 'sk-local-provider-secret'
  try {
    await saveProviderApiKey(apiKey)
    const stored = await readFile(path.join(directory, 'provider-secret.json'), 'utf8')
    assert.equal(stored.includes(apiKey), false)
    assert.equal(await providerApiKeyConfigured(), true)
    assert.equal(await loadProviderApiKey(), apiKey)

    await saveProviderApiKey('')
    assert.equal(await providerApiKeyConfigured(), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
