import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadAnalysisSettings,
  githubCredentialStatus,
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
import { saveProviderApiKey } from './provider-secret.js'
import { saveGitHubApiKey } from './github-secret.js'
import { createWindowEventHub } from './window-events.js'
import { createWindowRunner } from './window-runner.js'
import { loadWindowArtifact } from './window-reports.js'
import { createWindowScheduler } from './window-scheduler.js'
import { createWindowStore } from './window-store.js'
import {
  authenticate,
  authenticationStatus,
  createSession,
  destroySession,
  ensureBootstrapAdmin,
  expiredSessionCookie,
  requireAuthenticatedAdmin,
  sessionCookie,
} from './auth.js'

const app = express()
const port = Number(process.env.VIGIL_PORT || 8787)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

app.disable('x-powered-by')
app.use(express.json({ limit: '4mb' }))

await ensureBootstrapAdmin()

const windowEvents = createWindowEventHub()
const schedulerStore = {
  async recoverStaleRuns(now) {
    return createWindowStore(await loadAnalysisSettings()).recoverStaleRuns(now)
  },
  async list() {
    return createWindowStore(await loadAnalysisSettings()).list()
  },
  async retry(id, now) {
    return createWindowStore(await loadAnalysisSettings()).retry(id, now)
  },
}
const windowScheduler = createWindowScheduler({
  loadSettings: loadAnalysisSettings,
  loadRepositories: loadWatchedRepositories,
  store: schedulerStore,
  events: windowEvents,
  runner: {
    run(range, settings, repositories) {
      return createWindowRunner({ store: createWindowStore(settings), events: windowEvents }).run(range, settings, repositories)
    },
  },
})
await windowScheduler.start()

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'vigil-api' })
})

app.get('/api/auth/status', async (request, response, next) => {
  try {
    response.json(await authenticationStatus(request))
  } catch (error) {
    next(error)
  }
})

app.post('/api/auth/login', async (request, response, next) => {
  try {
    const user = await authenticate(String(request.body.username || ''), String(request.body.password || ''))
    if (!user) return response.status(401).json({ error: '用户名或密码不正确' })
    response.setHeader('Set-Cookie', sessionCookie(createSession(user)))
    return response.json({ user: { username: user.username, role: user.role } })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/auth/logout', (request, response) => {
  destroySession(request)
  response.setHeader('Set-Cookie', expiredSessionCookie())
  response.status(204).end()
})

app.use('/api', (request, response, next) => {
  if (request.path === '/health' || request.path.startsWith('/auth/')) return next()
  // Public visitors can inspect already-persisted repository intelligence. Any
  // operation that can spend provider/API quota or mutate configuration remains
  // an administrator action.
  if (request.method === 'GET' && !request.path.startsWith('/settings/') && request.path !== '/digital-humans') return next()
  return requireAuthenticatedAdmin(request, response, next)
})

app.get('/api/system-status', async (_request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    const repositories = await loadWatchedRepositories(settings)
    response.json(await collectSystemStatus(settings, repositories, process.env, await windowScheduler.status()))
  } catch (error) {
    next(error)
  }
})

app.get('/api/windows', async (_request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    response.json({ windows: await createWindowStore(settings).list(), scheduler: await windowScheduler.status() })
  } catch (error) {
    next(error)
  }
})

app.get('/api/windows/:id/events', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    const window = await createWindowStore(settings).load(request.params.id)
    if (!window) return response.status(404).json({ error: 'Window not found' })
    response.status(200)
    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache')
    response.setHeader('Connection', 'keep-alive')
    response.flushHeaders()
    const writeEvent = (event) => response.write(`event: window\ndata: ${JSON.stringify(event)}\n\n`)
    for (const event of window.events) writeEvent(event)
    const unsubscribe = windowEvents.subscribe(window.id, writeEvent)
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 25000)
    request.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/windows/:id/download', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    const format = request.query.format === 'json' ? 'json' : 'markdown'
    const artifact = await loadWindowArtifact(settings, request.params.id, format)
    if (!artifact) return response.status(404).json({ error: 'Window artifact not found' })
    const safeId = request.params.id.replace(/[^A-Za-z0-9_.-]+/g, '--').slice(0, 180)
    response.setHeader('Content-Disposition', `attachment; filename="vigil-window-${safeId}.${format === 'json' ? 'json' : 'md'}"`)
    return response.sendFile(artifact.path)
  } catch (error) {
    return next(error)
  }
})

app.get('/api/windows/:id', async (request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    const window = await createWindowStore(settings).load(request.params.id)
    if (!window) return response.status(404).json({ error: 'Window not found' })
    return response.json({ window })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/windows/trigger', async (request, response, next) => {
  try {
    const window = await windowScheduler.trigger({ rangeEnd: request.body.rangeEnd })
    return response.status(202).json({ accepted: true, window })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/windows/:id/retry', async (request, response, next) => {
  try {
    const window = await windowScheduler.retry(request.params.id)
    return response.status(202).json({ accepted: true, window })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/settings/analysis', async (_request, response, next) => {
  try {
    const settings = await loadAnalysisSettings()
    response.json({ settings, credential: await providerCredentialStatus(settings), githubCredential: await githubCredentialStatus() })
  } catch (error) {
    next(error)
  }
})

app.put('/api/settings/analysis', async (request, response, next) => {
  try {
    const settings = await saveAnalysisSettings(request.body)
    await windowScheduler.scan()
    response.json({ settings, credential: await providerCredentialStatus(settings), githubCredential: await githubCredentialStatus() })
  } catch (error) {
    next(error)
  }
})

app.put('/api/settings/provider-key', async (request, response, next) => {
  try {
    await saveProviderApiKey(request.body.apiKey)
    const settings = await loadAnalysisSettings()
    response.json({ credential: await providerCredentialStatus(settings) })
  } catch (error) {
    next(error)
  }
})

app.put('/api/settings/github-key', async (request, response, next) => {
  try {
    response.json({ credential: await saveGitHubApiKey(request.body.apiKey) })
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
    if ((await providerCredentialStatus(settings)).providerReady) {
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
    if ((await providerCredentialStatus(settings)).providerReady) {
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
    if (!binding) await ensureProviderCredential(settings)
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
