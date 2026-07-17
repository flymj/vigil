async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with status ${response.status}`)
  }
  return payload
}

export function getAuthenticationStatus() {
  return request('/api/auth/status')
}

export function login(username, password) {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export function logout() {
  return request('/api/auth/logout', { method: 'POST' })
}

export function getAnalysisSettings() {
  return request('/api/settings/analysis')
}

export function saveAnalysisSettings(settings) {
  return request('/api/settings/analysis', {
    method: 'PUT',
    body: JSON.stringify(settings),
  })
}

export function saveProviderApiKey(apiKey) {
  return request('/api/settings/provider-key', {
    method: 'PUT',
    body: JSON.stringify({ apiKey }),
  })
}

export function saveGitHubApiKey(apiKey) {
  return request('/api/settings/github-key', {
    method: 'PUT',
    body: JSON.stringify({ apiKey }),
  })
}

export function testProvider(settings) {
  return request('/api/providers/test', {
    method: 'POST',
    body: JSON.stringify(settings),
  })
}

export function getDigitalHumanAdapterStatus() {
  return request('/api/digital-humans')
}

export function runDeepDive(signal) {
  return request('/api/deep-dives', {
    method: 'POST',
    body: JSON.stringify({
      change: {
        id: signal.id,
        repository: signal.repo,
        title: signal.title,
        summary: signal.summary,
        facts: signal.facts,
        current_inference: signal.inference,
        unknowns: [signal.unknown],
        attention_score: signal.score,
        topic: signal.topic,
        status: signal.status,
      },
    }),
  })
}

function repositorySource(repository) {
  const sourceType = repository.sourceType === 'gerrit' ? 'gerrit' : 'github'
  const project = repository.project || `${repository.org}/${repository.name}`
  const host = repository.host || (sourceType === 'github' ? 'github.com' : '')
  return {
    sourceType,
    host,
    project,
    branch: repository.branch || repository.defaultBranch || 'main',
    defaultBranch: repository.defaultBranch || repository.branch || 'main',
    cloneUrl: repository.cloneUrl || (sourceType === 'github' ? `https://github.com/${project}.git` : `https://${host}/${project}`),
    browseUrl: repository.browseUrl || (sourceType === 'github' ? `https://github.com/${project}` : `https://${host}/admin/repos/${project}`),
    apiBaseUrl: repository.apiBaseUrl || (sourceType === 'github' ? 'https://api.github.com' : `https://${host}`),
  }
}

export function getHotPullRequests(repository, range) {
  return request('/api/repository-intelligence/hot-changes', {
    method: 'POST',
    body: JSON.stringify({ repository: repositorySource(repository), ...range, limit: 10 }),
  })
}

export function generateRepositorySummary(repository, range, force = false) {
  return request('/api/repository-intelligence/summaries', {
    method: 'POST',
    body: JSON.stringify({ repository: repositorySource(repository), ...range, force }),
  })
}

export function checkCachedSummary(repository, range) {
  return request('/api/repository-intelligence/summaries', {
    method: 'POST',
    body: JSON.stringify({ repository: repositorySource(repository), ...range, cacheOnly: true }),
  }).catch((error) => {
    if (error.message === 'Request failed with status 404') return null
    throw error
  })
}

export function snoopPullRequest(repository, number) {
  return request('/api/repository-intelligence/snoop', {
    method: 'POST',
    body: JSON.stringify({ repository: repositorySource(repository), changeNumber: number }),
  })
}

export function repositorySummaryDownloadUrl(repository, range, format = 'markdown') {
  const query = new URLSearchParams({ ...repositorySource(repository), from: range.from, to: range.to, format })
  return `/api/repository-intelligence/summaries/download?${query}`
}

export function inspectRepositoryAddress(address) {
  return request('/api/repository-sources/inspect', {
    method: 'POST',
    body: JSON.stringify({ address }),
  })
}

export function getWatchedRepositories() {
  return request('/api/watch-repositories')
}

export function getSystemStatus() {
  return request('/api/system-status')
}

export function getWindows() {
  return request('/api/windows')
}

export function getWindow(id) {
  return request(`/api/windows/${encodeURIComponent(id)}`)
}

export function triggerWindow(rangeEnd) {
  return request('/api/windows/trigger', {
    method: 'POST',
    body: JSON.stringify({ rangeEnd }),
  })
}

export function retryWindow(id) {
  return request(`/api/windows/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  })
}

export function windowDownloadUrl(id, format = 'markdown') {
  return `/api/windows/${encodeURIComponent(id)}/download?format=${format === 'json' ? 'json' : 'markdown'}`
}

export function subscribeToWindowEvents(id, onEvent) {
  const source = new EventSource(`/api/windows/${encodeURIComponent(id)}/events`)
  source.addEventListener('window', (event) => onEvent(JSON.parse(event.data)))
  return () => source.close()
}

export function addWatchedRepository(source, metadata) {
  return request('/api/watch-repositories', {
    method: 'POST',
    body: JSON.stringify({ source, metadata }),
  })
}

export function syncWatchedRepository(id) {
  return request(`/api/watch-repositories/${encodeURIComponent(id)}/sync`, {
    method: 'POST',
  })
}
