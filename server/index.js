import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadAnalysisSettings,
  normalizeAnalysisSettings,
  providerCredentialStatus,
  saveAnalysisSettings,
} from './config.js'
import { prepareRepositoryContext } from './git-context.js'
import { collectHotPullRequests, collectRepositoryWindow, normalizeTimeRange, snoopPullRequest } from './github.js'
import { createDigitalHumanAdapter } from './digital-human-adapter.js'
import { ensureProviderCredential, executeDeepDive, executeRepositorySummary, testProviderConnection } from './provider.js'
import { loadRepositorySummary, persistRepositorySummary, structuredRepositorySummary } from './reports.js'
import { collectHotChanges, collectSourceWindow, repositoryReportKey, snoopChange } from './repository-intelligence.js'
import { inspectRepositoryAddress, normalizeRepositorySource } from './repository-source.js'
import { loadWatchedRepositories, persistWatchedRepository, updateWatchedRepository } from './repository-store.js'
import { syncFullRepository } from './repository-sync.js'
import { collectSystemStatus } from './system-status.js'

const app = express()
const port = Number(process.env.VIGIL_PORT || 8787)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

app.disable('x-powered-by')
app.use(express.json({ limit: '4mb' }))

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'vigil-api' })
})

app.get('/api/system-status', async (_request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    const repositories = await loadWatchedRepositories(settings)
    response.json(await collectSystemStatus(settings, repositories))
  } catch (error) {
    next(error)
  }
})

app.get('/api/settings/analysis', async (_request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    response.json({ settings, credential: providerCredentialStatus(settings) })
  } catch (error) {
    next(error)
  }
})

app.put('/api/settings/analysis', async (request, response, next) => {
  try {
    const settings = await saveAnalysisSettings(request.body)
    response.json({ settings, credential: providerCredentialStatus(settings) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/providers/test', async (request, response, next) => {
  try {
    const settings = normalizeAnalysisSettings(request.body)
    response.json(await testProviderConnection(settings))
  } catch (error) {
    next(error)
  }
})

app.get('/api/digital-humans', async (_request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    response.json(await createDigitalHumanAdapter(settings).listAvailable())
  } catch (error) {
    next(error)
  }
})

app.post('/api/repository-sources/inspect', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    response.json(await inspectRepositoryAddress(request.body.address, settings))
  } catch (error) {
    next(error)
  }
})

app.get('/api/watch-repositories', async (_request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    response.json({ repositories: await loadWatchedRepositories(settings) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/watch-repositories', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    const source = normalizeRepositorySource(request.body.source)
    let repository = await persistWatchedRepository(settings, source, request.body.metadata)
    if (repository.syncMode === 'full') {
      repository = await updateWatchedRepository(settings, repository.id, { syncStatus: 'syncing', syncError: '' })
      try {
        const result = await syncFullRepository(settings, repository)
        repository = await updateWatchedRepository(settings, repository.id, {
          syncStatus: 'ready',
          localPath: result.localPath,
          lastFullSync: result.syncedAt,
          headSha: result.headSha,
          syncError: '',
        })
      } catch (error) {
        repository = await updateWatchedRepository(settings, repository.id, {
          syncStatus: 'failed',
          syncError: error.message,
        })
      }
    }
    response.status(201).json({ repository })
  } catch (error) {
    next(error)
  }
})

app.post('/api/watch-repositories/:id/sync', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    const repositories = await loadWatchedRepositories(settings)
    const repository = repositories.find((item) => item.id === request.params.id)
    if (!repository) return response.status(404).json({ error: 'Watched repository not found' })
    await updateWatchedRepository(settings, repository.id, { syncMode: 'full', syncStatus: 'syncing', syncError: '' })
    try {
      const result = await syncFullRepository(settings, repository)
      const updated = await updateWatchedRepository(settings, repository.id, {
        syncMode: 'full',
        syncStatus: 'ready',
        localPath: result.localPath,
        lastFullSync: result.syncedAt,
        headSha: result.headSha,
        syncError: '',
      })
      return response.json({ repository: updated })
    } catch (error) {
      const updated = await updateWatchedRepository(settings, repository.id, { syncStatus: 'failed', syncError: error.message })
      return response.status(502).json({ error: error.message, repository: updated })
    }
  } catch (error) {
    return next(error)
  }
})

app.post('/api/repository-intelligence/hot-changes', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    const source = normalizeRepositorySource(request.body.repository)
    const range = normalizeTimeRange(request.body.from, request.body.to)
    const limit = Math.min(20, Math.max(1, Number(request.body.limit || 10)))
    const pullRequests = await collectHotChanges(settings, source, range, limit)
    response.json({ repository: repositoryReportKey(source), sourceType: source.sourceType, range, pullRequests })
  } catch (error) {
    next(error)
  }
})

app.post('/api/repository-intelligence/snoop', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    response.json(await snoopChange(settings, request.body.repository, request.body.changeNumber))
  } catch (error) {
    next(error)
  }
})

app.post('/api/repository-intelligence/summaries', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    const source = normalizeRepositorySource(request.body.repository)
    const range = normalizeTimeRange(request.body.from, request.body.to)
    const reportKey = repositoryReportKey(source)
    if (!request.body.force) {
      const cached = await loadRepositorySummary(settings, reportKey, range)
      if (cached) return response.json({ ...cached.report, artifactId: cached.artifactId, cacheHit: true })
    }
    const snapshot = await collectSourceWindow(settings, source, range)
    let analysis = structuredRepositorySummary(snapshot)
    let analysisError = null
    if (providerCredentialStatus(settings).apiKeyConfigured) {
      try {
        analysis = await executeRepositorySummary(settings, snapshot)
      } catch (error) {
        analysisError = error.message
      }
    }
    const report = { snapshot, analysis, analysisError, generatedAt: new Date().toISOString() }
    const artifacts = await persistRepositorySummary(settings, report)
    return response.json({ ...report, artifactId: artifacts.artifactId, cacheHit: false })
  } catch (error) {
    next(error)
  }
})

app.get('/api/repository-intelligence/summaries/download', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    const source = normalizeRepositorySource({
      sourceType: request.query.sourceType,
      host: request.query.host,
      project: request.query.project,
      branch: request.query.branch,
      cloneUrl: request.query.cloneUrl,
      apiBaseUrl: request.query.apiBaseUrl,
    })
    const range = normalizeTimeRange(request.query.from, request.query.to)
    const cached = await loadRepositorySummary(settings, repositoryReportKey(source), range)
    if (!cached) return response.status(404).json({ error: 'Repository summary has not been generated for this exact source, branch, and time range' })
    const format = request.query.format === 'json' ? 'json' : 'markdown'
    const safeProject = source.project.replace(/[^A-Za-z0-9_.-]+/g, '--')
    const safeBranch = source.branch.replace(/[^A-Za-z0-9_.-]+/g, '--')
    const filename = `${source.sourceType}--${safeProject}--${safeBranch}--${range.from.slice(0, 10)}--${range.to.slice(0, 10)}.${format === 'json' ? 'json' : 'md'}`
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return response.sendFile(format === 'json' ? cached.jsonPath : cached.markdownPath)
  } catch (error) {
    return next(error)
  }
})

app.get('/api/repositories/:owner/:repository/hot-pull-requests', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    const range = normalizeTimeRange(request.query.from, request.query.to)
    const limit = Math.min(20, Math.max(1, Number(request.query.limit || 10)))
    const pullRequests = await collectHotPullRequests(settings, request.params.owner, request.params.repository, range, limit)
    response.json({ repository: `${request.params.owner}/${request.params.repository}`, range, pullRequests })
  } catch (error) {
    next(error)
  }
})

app.get('/api/repositories/:owner/:repository/pull-requests/:number/snoop', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    response.json(await snoopPullRequest(settings, request.params.owner, request.params.repository, request.params.number))
  } catch (error) {
    next(error)
  }
})

app.post('/api/repositories/:owner/:repository/summaries', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    const range = normalizeTimeRange(request.body.from, request.body.to)
    const fullName = `${request.params.owner}/${request.params.repository}`
    if (!request.body.force) {
      const cached = await loadRepositorySummary(settings, fullName, range)
      if (cached) {
        return response.json({ ...cached.report, artifactId: cached.artifactId, cacheHit: true })
      }
    }
    const snapshot = await collectRepositoryWindow(settings, request.params.owner, request.params.repository, range)
    let analysis = structuredRepositorySummary(snapshot)
    let analysisError = null
    if (providerCredentialStatus(settings).apiKeyConfigured) {
      try {
        analysis = await executeRepositorySummary(settings, snapshot)
      } catch (error) {
        analysisError = error.message
      }
    }
    const report = { snapshot, analysis, analysisError, generatedAt: new Date().toISOString() }
    const artifacts = await persistRepositorySummary(settings, report)
    return response.json({ ...report, artifactId: artifacts.artifactId, cacheHit: false })
  } catch (error) {
    next(error)
  }
})

app.get('/api/repositories/:owner/:repository/summaries/download', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    const range = normalizeTimeRange(request.query.from, request.query.to)
    const fullName = `${request.params.owner}/${request.params.repository}`
    const cached = await loadRepositorySummary(settings, fullName, range)
    if (!cached) return response.status(404).json({ error: 'Repository summary has not been generated for this exact time range' })
    const format = request.query.format === 'json' ? 'json' : 'markdown'
    const filename = `${request.params.owner}--${request.params.repository}--${range.from.slice(0, 10)}--${range.to.slice(0, 10)}.${format === 'json' ? 'json' : 'md'}`
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return response.sendFile(format === 'json' ? cached.jsonPath : cached.markdownPath)
  } catch (error) {
    return next(error)
  }
})

app.post('/api/deep-dives', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    if (!settings.deepDive.enabled) return response.status(409).json({ error: 'Deep Dive 当前已禁用' })
    const digitalHumanAdapter = createDigitalHumanAdapter(settings)
    const binding = settings.digitalHuman.enabled
      ? await digitalHumanAdapter.resolveBinding(settings.digitalHuman.bindingRef)
      : null
    if (!binding) ensureProviderCredential(settings)
    const repositoryContext = request.body.codeContext
      || await prepareRepositoryContext(request.body.change || {}, settings)
    const result = binding
      ? await digitalHumanAdapter.invokeDeepDive(binding, request.body, repositoryContext)
      : await executeDeepDive(settings, request.body, repositoryContext)
    return response.json(result)
  } catch (error) {
    return next(error)
  }
})

app.use(express.static(path.join(root, 'dist')))
app.use((request, response, next) => {
  if (request.method === 'GET' && !request.path.startsWith('/api/')) {
    return response.sendFile(path.join(root, 'dist', 'index.html'))
  }
  return next()
})

app.use((error, _request, response, _next) => {
  const status = error.name === 'AbortError' ? 504 : 400
  response.status(status).json({ error: error.message || 'Unexpected server error' })
})

app.listen(port, '127.0.0.1', () => {
  console.log(`Vigil API listening on http://127.0.0.1:${port}`)
})
