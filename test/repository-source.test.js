import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  normalizeRepositorySource,
  parseRepositoryAddress,
  repositoryIdentity,
} from '../server/repository-source.js'
import { loadWatchedRepositories, persistWatchedRepository, deleteWatchedRepository } from '../server/repository-store.js'

test('parses GitHub and Gerrit repository addresses into a common source shape', () => {
  assert.deepEqual(parseRepositoryAddress('vllm-project/vllm'), {
    sourceType: 'github',
    host: 'github.com',
    project: 'vllm-project/vllm',
    cloneUrl: 'https://github.com/vllm-project/vllm.git',
    browseUrl: 'https://github.com/vllm-project/vllm',
    apiBaseUrl: 'https://api.github.com',
  })

  assert.deepEqual(parseRepositoryAddress('git@github.com:vllm-project/vllm'), {
    sourceType: 'github',
    host: 'github.com',
    project: 'vllm-project/vllm',
    cloneUrl: 'https://github.com/vllm-project/vllm.git',
    browseUrl: 'https://github.com/vllm-project/vllm',
    apiBaseUrl: 'https://api.github.com',
  })

  assert.deepEqual(parseRepositoryAddress('ssh://flymj@gerrit.example.com:29418/platform/runtime'), {
    sourceType: 'gerrit',
    host: 'gerrit.example.com',
    project: 'platform/runtime',
    cloneUrl: 'ssh://flymj@gerrit.example.com:29418/platform/runtime',
    browseUrl: 'https://gerrit.example.com/admin/repos/platform/runtime',
    apiBaseUrl: 'https://gerrit.example.com',
  })

  assert.equal(
    parseRepositoryAddress('https://gerrit.example.com/c/platform/runtime/+/12345').project,
    'platform/runtime',
  )
  assert.equal(
    parseRepositoryAddress('https://gerrit.example.com:8443/platform/runtime').apiBaseUrl,
    'https://gerrit.example.com:8443',
  )
})

test('selected branch is part of the normalized persistent identity', () => {
  const main = normalizeRepositorySource({
    ...parseRepositoryAddress('https://gerrit.example.com/platform/runtime'),
    branch: 'main',
  })
  const release = normalizeRepositorySource({ ...main, branch: 'release/2.0' })

  assert.equal(main.branch, 'main')
  assert.notEqual(repositoryIdentity(main), repositoryIdentity(release))
  assert.throws(() => normalizeRepositorySource({ ...main, branch: '' }), /branch/i)
  assert.throws(() => normalizeRepositorySource({ ...main, branch: '-upload-pack=touch /tmp/nope' }), /branch/i)
  assert.throws(() => normalizeRepositorySource({ ...main, cloneUrl: '--upload-pack=touch /tmp/nope' }), /clone URL/i)
})

test('watch repository persistence keeps the selected branch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vigil-watchlist-'))
  const settings = { workspace: { directory } }
  const source = normalizeRepositorySource({
    ...parseRepositoryAddress('https://gerrit.example.com/platform/runtime'),
    branch: 'stable',
    defaultBranch: 'main',
  })

  try {
    const saved = await persistWatchedRepository(settings, source, { syncMode: 'full' })
    const loaded = await loadWatchedRepositories(settings)
    assert.equal(saved.branch, 'stable')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].branch, 'stable')
    assert.equal(loaded[0].sourceType, 'gerrit')
    assert.equal(loaded[0].syncMode, 'full')
    assert.equal((await readFile(path.join(directory, 'watchlist.json'), 'utf8')).includes('stable'), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('loading a legacy GitHub SSH watch migrates it from Gerrit and persists the correction', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vigil-watchlist-migration-'))
  const settings = { workspace: { directory } }
  const legacy = {
    sourceType: 'gerrit',
    host: 'github.com',
    project: 'vllm-project/vllm',
    cloneUrl: 'git@github.com:vllm-project/vllm',
    browseUrl: 'https://github.com/admin/repos/vllm-project/vllm',
    apiBaseUrl: 'https://github.com',
    branch: 'main',
    defaultBranch: 'main',
    id: 'legacy-gerrit-id',
    syncMode: 'full',
  }
  try {
    await writeFile(
      path.join(directory, 'watchlist.json'),
      `${JSON.stringify({ version: 1, repositories: [legacy] })}\n`,
    )
    const [repository] = await loadWatchedRepositories(settings)
    const saved = JSON.parse(await readFile(path.join(directory, 'watchlist.json'), 'utf8'))
    assert.equal(repository.sourceType, 'github')
    assert.equal(repository.apiBaseUrl, 'https://api.github.com')
    assert.equal(repository.cloneUrl, 'https://github.com/vllm-project/vllm.git')
    assert.equal(saved.repositories[0].sourceType, 'github')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('concurrent watchlist writes do not lose repositories', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vigil-watchlist-race-'))
  const settings = { workspace: { directory } }
  const first = normalizeRepositorySource({ ...parseRepositoryAddress('owner/first'), branch: 'main' })
  const second = normalizeRepositorySource({ ...parseRepositoryAddress('owner/second'), branch: 'release' })
  try {
    await Promise.all([
      persistWatchedRepository(settings, first),
      persistWatchedRepository(settings, second),
    ])
    const loaded = await loadWatchedRepositories(settings)
    assert.deepEqual(new Set(loaded.map((repository) => repository.project)), new Set(['owner/first', 'owner/second']))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('deleteWatchedRepository removes a watch from the list and throws when id is unknown', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vigil-watchlist-delete-'))
  const settings = { workspace: { directory } }
  const first = normalizeRepositorySource({ ...parseRepositoryAddress('owner/first'), branch: 'main' })
  const second = normalizeRepositorySource({ ...parseRepositoryAddress('owner/second'), branch: 'main' })
  try {
    const saved = await persistWatchedRepository(settings, first)
    await persistWatchedRepository(settings, second)
    assert.equal((await loadWatchedRepositories(settings)).length, 2)
    await deleteWatchedRepository(settings, saved.id)
    const remaining = await loadWatchedRepositories(settings)
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].project, 'owner/second')
    await assert.rejects(deleteWatchedRepository(settings, saved.id), /not found/i)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
