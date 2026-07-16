import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { normalizeRepositorySource } from './repository-source.js'

let watchlistMutationQueue = Promise.resolve()

function watchlistPath(settings) {
  return path.join(settings.workspace.directory, 'watchlist.json')
}

async function writeWatchlist(settings, repositories) {
  const target = watchlistPath(settings)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(settings.workspace.directory, { recursive: true, mode: 0o700 })
  await writeFile(temporary, `${JSON.stringify({ version: 1, repositories }, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

function serializeWatchlistMutation(operation) {
  const result = watchlistMutationQueue.then(operation, operation)
  watchlistMutationQueue = result.then(() => undefined, () => undefined)
  return result
}

export async function loadWatchedRepositories(settings) {
  try {
    const payload = JSON.parse(await readFile(watchlistPath(settings), 'utf8'))
    return Array.isArray(payload.repositories) ? payload.repositories : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export async function persistWatchedRepository(settings, sourceValue, metadata = {}) {
  const source = normalizeRepositorySource(sourceValue)
  const segments = source.project.split('/')
  const repository = {
    ...source,
    name: segments.at(-1),
    org: segments.slice(0, -1).join('/') || source.host,
    initial: segments.at(-1).slice(0, 2).toUpperCase(),
    color: source.sourceType === 'gerrit' ? '#ff9257' : '#d5ff3f',
    weight: String(metadata.weight || '1.0'),
    criticalPaths: String(metadata.criticalPaths || ''),
    syncMode: metadata.syncMode === 'full' ? 'full' : 'on-demand',
    syncStatus: metadata.syncMode === 'full' ? 'pending' : 'on-demand',
    localPath: '',
    syncError: '',
    lastFullSync: null,
    createdAt: new Date().toISOString(),
  }
  return serializeWatchlistMutation(async () => {
    const current = await loadWatchedRepositories(settings)
    const existing = current.find((item) => item.id === repository.id)
    if (existing) repository.createdAt = existing.createdAt || repository.createdAt
    const next = [repository, ...current.filter((item) => item.id !== repository.id)]
    await writeWatchlist(settings, next)
    return repository
  })
}

export async function updateWatchedRepository(settings, id, patch) {
  return serializeWatchlistMutation(async () => {
    const current = await loadWatchedRepositories(settings)
    const index = current.findIndex((repository) => repository.id === id)
    if (index < 0) throw new Error('Watched repository not found')
    const repository = {
      ...current[index],
      ...patch,
      id: current[index].id,
      sourceType: current[index].sourceType,
      host: current[index].host,
      project: current[index].project,
      branch: current[index].branch,
    }
    const next = [...current]
    next[index] = repository
    await writeWatchlist(settings, next)
    return repository
  })
}
