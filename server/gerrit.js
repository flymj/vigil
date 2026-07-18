function trimText(value, max = 2000) {
  const text = String(value || '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function gerritDate(value) {
  if (!value) return null
  const normalized = String(value).replace(' ', 'T').replace(/\.\d+$/, '')
  const date = new Date(`${normalized}Z`)
  return Number.isFinite(date.getTime()) ? date : new Date(value)
}

export function parseGerritJson(text) {
  const payload = String(text || '').replace(/^\)\]\}'\s*\n?/, '')
  return payload ? JSON.parse(payload) : null
}

function labelVotes(labels = {}) {
  return Object.values(labels).flatMap((label) => label?.all || []).filter((vote) => Number(vote.value || 0) > 0).length
}

function currentFiles(change) {
  const revision = change.revisions?.[change.current_revision] || {}
  return Object.entries(revision.files || {}).filter(([filename]) => filename !== '/COMMIT_MSG')
}

function gerritHotScore(change, now = Date.now()) {
  const updated = gerritDate(change.updated)?.getTime() || now
  const ageHours = Math.max(0, (now - updated) / 3600000)
  const freshness = Math.max(0, 30 - Math.log2(ageHours + 1) * 5)
  const discussion = Number(change.total_comment_count || change.messages?.length || 0) * 2.5
  const votes = labelVotes(change.labels) * 4
  const scale = Math.min(30, currentFiles(change).length * 1.4)
  const attention = change.work_in_progress ? 0 : 5
  return Math.round(Math.min(100, freshness + discussion + votes + scale + attention))
}

function changeUrl(repository, number, project = repository.project) {
  return `${repository.apiBaseUrl.replace(/\/+$/, '')}/c/${project}/+/${number}`
}

export function normalizeGerritChange(change, repository, now = Date.now()) {
  const files = currentFiles(change)
  return {
    id: change.id,
    number: Number(change._number),
    changeId: change.change_id || change.id,
    sourceType: 'gerrit',
    title: change.subject || '',
    url: changeUrl(repository, change._number, change.project),
    state: String(change.status || 'NEW').toLowerCase(),
    draft: Boolean(change.work_in_progress),
    author: change.owner?.username || change.owner?.name || change.owner?.email || '',
    avatarUrl: change.owner?.avatars?.at(-1)?.url || '',
    createdAt: gerritDate(change.created)?.toISOString() || null,
    updatedAt: gerritDate(change.updated)?.toISOString() || null,
    comments: Number(change.total_comment_count || change.messages?.length || 0),
    reactions: labelVotes(change.labels),
    labels: Object.keys(change.labels || {}),
    additions: Number(change.insertions || files.reduce((sum, [, file]) => sum + Number(file.lines_inserted || 0), 0)),
    deletions: Number(change.deletions || files.reduce((sum, [, file]) => sum + Number(file.lines_deleted || 0), 0)),
    changedFiles: files.length,
    commits: Object.keys(change.revisions || {}).length || 1,
    reviewComments: Number(change.unresolved_comment_count || 0),
    baseBranch: change.branch || '',
    headBranch: `change/${change._number}`,
    hotScore: gerritHotScore(change, now),
  }
}

function gerritHeaders(settings) {
  const username = settings.gerrit.usernameEnv ? process.env[settings.gerrit.usernameEnv] : ''
  const password = settings.gerrit.passwordEnv ? process.env[settings.gerrit.passwordEnv] : ''
  return {
    Accept: 'application/json',
    'User-Agent': 'vigil-repository-intelligence',
    ...(username && password ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } : {}),
  }
}

async function gerritFetch(settings, repository, pathname, query = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), settings.gerrit.requestTimeoutSeconds * 1000)
  const authenticated = Boolean(
    settings.gerrit.usernameEnv && process.env[settings.gerrit.usernameEnv]
    && settings.gerrit.passwordEnv && process.env[settings.gerrit.passwordEnv],
  )
  const prefix = authenticated ? '/a' : ''
  const url = new URL(`${repository.apiBaseUrl.replace(/\/+$/, '')}${prefix}${pathname}`)
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, item))
    else if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  try {
    const response = await fetch(url, { signal: controller.signal, headers: gerritHeaders(settings) })
    const text = await response.text()
    const payload = parseGerritJson(text)
    if (!response.ok) {
      const message = payload?.message || payload?.error || response.statusText
      throw new Error(`Gerrit ${response.status}: ${message}`)
    }
    return payload
  } finally {
    clearTimeout(timeout)
  }
}

function gerritSearchTime(value) {
  return new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' +0000')
}

export function gerritTimeQuery(range) {
  return `after:"${gerritSearchTime(range.from)}" before:"${gerritSearchTime(range.to)}"`
}

function queryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

const changeOptions = [
  'DETAILED_ACCOUNTS',
  'CURRENT_REVISION',
  'CURRENT_COMMIT',
  'CURRENT_FILES',
  'DETAILED_LABELS',
  'MESSAGES',
  'SUBMITTABLE',
]

async function queryChanges(settings, repository, range, limit) {
  const query = `project:"${queryValue(repository.project)}" branch:"${queryValue(repository.branch)}" ${gerritTimeQuery(range)}`
  const payload = await gerritFetch(settings, repository, '/changes/', {
    q: query,
    n: Math.min(100, Math.max(10, limit)),
    o: changeOptions,
  })
  return Array.isArray(payload) ? payload : []
}

export async function collectHotGerritChanges(settings, repository, range, limit = 10) {
  const changes = await queryChanges(settings, repository, range, Math.max(limit * 2, 20))
  return changes
    .map((change) => normalizeGerritChange(change, repository))
    .sort((left, right) => right.hotScore - left.hotScore)
    .slice(0, limit)
}

function gerritChecks(labels = {}) {
  return Object.entries(labels).map(([name, label]) => {
    const votes = (label.all || []).map((vote) => Number(vote.value || 0))
    const value = votes.length ? Math.max(...votes) : 0
    const rejected = votes.some((vote) => vote < 0)
    return {
      name,
      status: 'completed',
      conclusion: rejected ? 'failure' : value > 0 ? 'success' : 'neutral',
      url: '',
    }
  })
}

export async function snoopGerritChange(settings, repository, changeNumber) {
  const number = Number(changeNumber)
  if (!Number.isInteger(number) || number <= 0) throw new Error('Invalid Gerrit change number')
  const encoded = encodeURIComponent(String(number))
  const [detail, commentsByFile] = await Promise.all([
    gerritFetch(settings, repository, `/changes/${encoded}/detail`, { o: changeOptions }),
    gerritFetch(settings, repository, `/changes/${encoded}/comments`),
  ])
  const revision = detail.revisions?.[detail.current_revision] || {}
  const files = Object.entries(revision.files || {})
    .filter(([filename]) => filename !== '/COMMIT_MSG')
    .map(([filename, file]) => ({
      filename,
      status: file.status || 'M',
      additions: Number(file.lines_inserted || 0),
      deletions: Number(file.lines_deleted || 0),
      changes: Number(file.lines_inserted || 0) + Number(file.lines_deleted || 0),
      patch: '',
    }))
  const comments = Object.entries(commentsByFile || {}).flatMap(([filename, items]) =>
    items.map((comment) => ({
      author: comment.author?.username || comment.author?.name || '',
      createdAt: gerritDate(comment.updated)?.toISOString() || null,
      body: trimText(comment.message, 2000),
      path: filename,
      line: comment.line || null,
      unresolved: Boolean(comment.unresolved),
    })),
  )
  const normalized = normalizeGerritChange(detail, repository)
  return {
    repository: `${repository.project}@${repository.branch}`,
    sourceType: 'gerrit',
    collectedAt: new Date().toISOString(),
    pullRequest: {
      ...normalized,
      body: trimText(revision.commit?.message || detail.subject, 8000),
      mergeableState: detail.submittable ? 'submittable' : detail.mergeable ? 'mergeable' : 'blocked',
      requestedReviewers: (detail.reviewers?.REVIEWER || []).map((reviewer) => reviewer.username || reviewer.name).filter(Boolean),
    },
    files,
    commits: detail.current_revision ? [{
      sha: detail.current_revision.slice(0, 12),
      fullSha: detail.current_revision,
      message: trimText(revision.commit?.message || detail.subject, 500),
      author: revision.commit?.author?.name || normalized.author,
      date: gerritDate(revision.commit?.author?.date)?.toISOString() || normalized.updatedAt,
    }] : [],
    reviews: (detail.messages || []).map((message) => ({
      author: message.author?.username || message.author?.name || 'Gerrit',
      state: message.tag || 'MESSAGE',
      submittedAt: gerritDate(message.date)?.toISOString() || null,
      body: trimText(message.message, 2000),
    })),
    comments,
    checks: gerritChecks(detail.labels),
  }
}

export async function collectGerritWindow(settings, repository, range) {
  const changes = await queryChanges(settings, repository, range, 100)
  const hotPullRequests = changes
    .map((change) => normalizeGerritChange(change, repository))
    .sort((left, right) => right.hotScore - left.hotScore)
    .slice(0, 10)
  const merged = changes.filter((change) => change.status === 'MERGED')
  return {
    repository: `${repository.project}@${repository.branch}`,
    repositoryKey: `gerrit:${repository.host}/${repository.project}@${repository.branch}`,
    sourceType: 'gerrit',
    branch: repository.branch,
    range,
    collectedAt: new Date().toISOString(),
    counts: {
      commits: merged.length,
      pullRequests: changes.length,
      issues: 0,
      releases: 0,
    },
    commits: merged.slice(0, 100).map((change) => ({
      sha: String(change.current_revision || '').slice(0, 12),
      fullSha: String(change.current_revision || ''),
      message: trimText(change.subject, 500),
      author: change.owner?.username || change.owner?.name || '',
      date: gerritDate(change.submitted || change.updated)?.toISOString() || null,
      url: changeUrl(repository, change._number),
    })),
    hotPullRequests,
    issues: [],
    releases: [],
  }
}
