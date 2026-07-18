function id(value, prefix) {
  const text = String(value || '')
  if (!new RegExp(`^${prefix}-[0-9a-f-]{36}$`).test(text)) throw new Error(`Invalid ${prefix} ID`)
  return text
}

function queryOptions(query) {
  return {
    query: String(query.q || '').slice(0, 120),
    status: String(query.status || '').slice(0, 40),
    limit: Number(query.limit || 50),
    offset: Number(query.offset || 0),
  }
}

function paginationOptions(query) {
  return { limit: Number(query.limit || 50), offset: Number(query.offset || 0) }
}

export function registerDreamRoutes(app, { loadSettings, getStore, scheduler, authenticationStatus }) {
  app.get('/api/signals', async (request, response, next) => {
    try {
      const settings = await loadSettings()
      const dream = await scheduler.status()
      if (dream.storageReady === false) return response.json({ items: [], total: 0, limit: 50, offset: 0, dream })
      return response.json({ ...getStore(settings).listSignals(queryOptions(request.query)), dream })
    } catch (error) { next(error) }
  })

  app.get('/api/signals/:id', async (request, response, next) => {
    try {
      const settings = await loadSettings()
      const dream = await scheduler.status()
      if (dream.storageReady === false) return response.status(503).json({ error: dream.reasons.join('; ') || 'Dream ledger is unavailable', dream })
      const signal = getStore(settings).getSignal(id(request.params.id, 'sig'))
      if (!signal) return response.status(404).json({ error: 'Technical Signal not found' })
      return response.json({ signal })
    } catch (error) { return next(error) }
  })

  app.get('/api/signals/:id/revisions', async (request, response, next) => {
    try {
      const settings = await loadSettings()
      const dream = await scheduler.status()
      if (dream.storageReady === false) return response.status(503).json({ error: dream.reasons.join('; ') || 'Dream ledger is unavailable', dream })
      const revisions = getStore(settings).listSignalRevisions(id(request.params.id, 'sig'), paginationOptions(request.query))
      if (!revisions) return response.status(404).json({ error: 'Technical Signal not found' })
      return response.json({ ...revisions, dream })
    } catch (error) { return next(error) }
  })

  app.get('/api/signals/:id/forecasts', async (request, response, next) => {
    try {
      const settings = await loadSettings()
      const dream = await scheduler.status()
      if (dream.storageReady === false) return response.status(503).json({ error: dream.reasons.join('; ') || 'Dream ledger is unavailable', dream })
      const forecasts = getStore(settings).listSignalForecasts(id(request.params.id, 'sig'), paginationOptions(request.query))
      if (!forecasts) return response.status(404).json({ error: 'Technical Signal not found' })
      return response.json({ ...forecasts, dream })
    } catch (error) { return next(error) }
  })

  app.get('/api/topics', async (request, response, next) => {
    try {
      const settings = await loadSettings()
      const dream = await scheduler.status()
      if (dream.storageReady === false) return response.json({ items: [], total: 0, limit: 50, offset: 0, dream })
      return response.json({ ...getStore(settings).listTopics(queryOptions(request.query)), dream })
    } catch (error) { next(error) }
  })

  app.get('/api/topics/:id', async (request, response, next) => {
    try {
      const settings = await loadSettings()
      const dream = await scheduler.status()
      if (dream.storageReady === false) return response.status(503).json({ error: dream.reasons.join('; ') || 'Dream ledger is unavailable', dream })
      const topic = getStore(settings).getTopic(id(request.params.id, 'top'))
      if (!topic) return response.status(404).json({ error: 'Technical Topic not found' })
      return response.json({ topic })
    } catch (error) { return next(error) }
  })

  app.get('/api/topics/:id/revisions', async (request, response, next) => {
    try {
      const settings = await loadSettings()
      const dream = await scheduler.status()
      if (dream.storageReady === false) return response.status(503).json({ error: dream.reasons.join('; ') || 'Dream ledger is unavailable', dream })
      const revisions = getStore(settings).listTopicRevisions(id(request.params.id, 'top'), paginationOptions(request.query))
      if (!revisions) return response.status(404).json({ error: 'Technical Topic not found' })
      return response.json({ ...revisions, dream })
    } catch (error) { return next(error) }
  })

  app.get('/api/topics/:id/signals', async (request, response, next) => {
    try {
      const settings = await loadSettings()
      const dream = await scheduler.status()
      if (dream.storageReady === false) return response.status(503).json({ error: dream.reasons.join('; ') || 'Dream ledger is unavailable', dream })
      const signals = getStore(settings).listTopicSignals(id(request.params.id, 'top'), paginationOptions(request.query))
      if (!signals) return response.status(404).json({ error: 'Technical Topic not found' })
      return response.json({ ...signals, dream })
    } catch (error) { return next(error) }
  })

  app.get('/api/dream-runs', async (request, response, next) => {
    try {
      const settings = await loadSettings()
      const dream = await scheduler.status()
      if (dream.storageReady === false) return response.json({ items: [], total: 0, limit: 50, offset: 0, dream })
      return response.json({ ...getStore(settings).listRuns({ status: String(request.query.status || '').slice(0, 40), limit: Number(request.query.limit || 50), offset: Number(request.query.offset || 0) }), dream })
    } catch (error) { next(error) }
  })

  app.get('/api/dream-runs/:id', async (request, response, next) => {
    try {
      const settings = await loadSettings()
      const dream = await scheduler.status()
      if (dream.storageReady === false) return response.status(503).json({ error: dream.reasons.join('; ') || 'Dream ledger is unavailable', dream })
      const auth = await authenticationStatus(request)
      const run = getStore(settings).getRun(id(request.params.id, 'run'), { includeAudit: Boolean(auth.authenticated) })
      if (!run) return response.status(404).json({ error: 'Dream run not found' })
      return response.json({ run, auditVisible: Boolean(auth.authenticated) })
    } catch (error) { return next(error) }
  })

  app.post('/api/dream-runs/trigger', async (request, response, next) => {
    try {
      const horizon = await scheduler.trigger({ horizonEnd: request.body?.horizonEnd })
      response.status(202).json({ accepted: true, horizon })
    } catch (error) { next(error) }
  })

  app.post('/api/dream-runs/:id/retry', async (request, response, next) => {
    try {
      const run = await scheduler.retry(id(request.params.id, 'run'))
      response.status(202).json({ accepted: true, run })
    } catch (error) { next(error) }
  })
}
