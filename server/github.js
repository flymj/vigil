function repositoryCoordinates(owner, repository) {
  const valid = /^[A-Za-z0-9_.-]+$/
  if (!valid.test(owner) || !valid.test(repository)) throw new Error('Invalid GitHub repository coordinates')
  return { owner, repository: repository.replace(/\.git$/, ''), fullName: `${owner}/${repository.replace(/\.git$/, '')}` }
}

export function normalizeTimeRange(fromValue, toValue) {
  const to = toValue ? new Date(toValue) : new Date()
  const from = fromValue ? new Date(fromValue) : new Date(to.getTime() - 24 * 60 * 60 * 1000)
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) throw new Error('Invalid time range')
  if (from >= to) throw new Error('Time range start must be before end')
  if (to.getTime() - from.getTime() > 90 * 24 * 60 * 60 * 1000) throw new Error('Time range cannot exceed 90 days')
  return { from: from.toISOString(), to: to.toISOString() }
}

function githubHeaders(settings) {
  const tokenName = settings.github.tokenEnv
  const token = tokenName ? process.env[tokenName] : ''
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'vigil-repository-intelligence',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function githubFetch(settings, pathname, query = {}, extraHeaders = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), settings.github.requestTimeoutSeconds * 1000)
  const url = new URL(`${settings.github.apiBaseUrl}${pathname}`)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { ...githubHeaders(settings), ...extraHeaders },
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const rate = response.headers.get('x-ratelimit-remaining')
      throw new Error(`GitHub ${response.status}: ${payload.message || response.statusText}${rate === '0' ? ' (rate limit exhausted)' : ''}`)
    }
    return payload
  } finally {
    clearTimeout(timeout)
  }
}

function reactionCount(reactions = {}) {
  return ['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes']
    .reduce((total, key) => total + Number(reactions[key] || 0), 0)
}

function hotScore(item, details, now = Date.now()) {
  const ageHours = Math.max(0, (now - new Date(item.updated_at).getTime()) / 3600000)
  const freshness = Math.max(0, 28 - Math.log2(ageHours + 1) * 5)
  const discussion = Number(item.comments || 0) * 2.4
  const reactions = reactionCount(item.reactions) * 3.2
  const scale = Math.min(30, Number(details?.changed_files || 0) * 1.4)
  const reviewSignal = details?.requested_reviewers?.length ? 8 : 0
  return Math.round(Math.min(100, freshness + discussion + reactions + scale + reviewSignal))
}

function normalizePullRequest(item, details = null) {
  const reactions = reactionCount(item.reactions)
  return {
    number: item.number,
    title: item.title,
    url: item.html_url,
    state: details?.merged_at ? 'merged' : item.state,
    draft: Boolean(details?.draft),
    author: item.user?.login || '',
    avatarUrl: item.user?.avatar_url || '',
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    comments: Number(item.comments || 0),
    reactions,
    labels: (item.labels || []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean),
    additions: Number(details?.additions || 0),
    deletions: Number(details?.deletions || 0),
    changedFiles: Number(details?.changed_files || 0),
    commits: Number(details?.commits || 0),
    reviewComments: Number(details?.review_comments || 0),
    baseBranch: details?.base?.ref || '',
    headBranch: details?.head?.ref || '',
    hotScore: hotScore(item, details),
  }
}

export async function collectHotPullRequests(settings, ownerValue, repositoryValue, range, limit = 10, branch = '') {
  const { owner, repository, fullName } = repositoryCoordinates(ownerValue, repositoryValue)
  const dateRange = `${range.from.slice(0, 10)}..${range.to.slice(0, 10)}`
  const search = await githubFetch(settings, '/search/issues', {
    q: `repo:${fullName} is:pr updated:${dateRange}`,
    sort: 'comments',
    order: 'desc',
    per_page: Math.min(30, Math.max(limit * 2, 10)),
  })
  const candidates = Array.isArray(search.items) ? search.items.slice(0, Math.min(20, limit * 2)) : []
  const detailResults = await Promise.allSettled(candidates.map((item) =>
    githubFetch(settings, `/repos/${owner}/${repository}/pulls/${item.number}`),
  ))
  return candidates
    .map((item, index) => ({
      item,
      details: detailResults[index].status === 'fulfilled' ? detailResults[index].value : null,
    }))
    .filter(({ details }) => !branch || details?.base?.ref === branch)
    .map(({ item, details }) => normalizePullRequest(item, details))
    .sort((left, right) => right.hotScore - left.hotScore)
    .slice(0, limit)
}

function trimText(value, max = 2000) {
  const text = String(value || '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export async function snoopPullRequest(settings, ownerValue, repositoryValue, numberValue) {
  const { owner, repository, fullName } = repositoryCoordinates(ownerValue, repositoryValue)
  const number = Number(numberValue)
  if (!Number.isInteger(number) || number <= 0) throw new Error('Invalid pull request number')
  const base = `/repos/${owner}/${repository}`
  const detail = await githubFetch(settings, `${base}/pulls/${number}`)
  const [files, commits, reviews, issueComments, reviewComments, checks] = await Promise.all([
    githubFetch(settings, `${base}/pulls/${number}/files`, { per_page: 100 }),
    githubFetch(settings, `${base}/pulls/${number}/commits`, { per_page: 100 }),
    githubFetch(settings, `${base}/pulls/${number}/reviews`, { per_page: 100 }),
    githubFetch(settings, `${base}/issues/${number}/comments`, { per_page: 100 }),
    githubFetch(settings, `${base}/pulls/${number}/comments`, { per_page: 100 }),
    githubFetch(settings, `${base}/commits/${detail.head.sha}/check-runs`, { per_page: 100 }),
  ])
  return {
    repository: fullName,
    collectedAt: new Date().toISOString(),
    pullRequest: {
      ...normalizePullRequest({ ...detail, comments: detail.comments, reactions: detail.reactions }, detail),
      body: trimText(detail.body, 8000),
      baseBranch: detail.base?.ref || '',
      headBranch: detail.head?.ref || '',
      mergeableState: detail.mergeable_state || '',
      requestedReviewers: (detail.requested_reviewers || []).map((reviewer) => reviewer.login),
    },
    files: files.map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes, patch: trimText(file.patch, 5000) })),
    commits: commits.map((commit) => ({ sha: commit.sha.slice(0, 12), message: trimText(commit.commit?.message, 500), author: commit.author?.login || commit.commit?.author?.name || '', date: commit.commit?.author?.date })),
    reviews: reviews.map((review) => ({ author: review.user?.login || '', state: review.state, submittedAt: review.submitted_at, body: trimText(review.body, 2000) })),
    comments: [...issueComments, ...reviewComments].map((comment) => ({ author: comment.user?.login || '', createdAt: comment.created_at, body: trimText(comment.body, 2000), path: comment.path || null })),
    checks: (checks.check_runs || []).map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion, url: check.html_url })),
  }
}

export async function collectRepositoryWindow(settings, owner, repository, range, branch = '') {
  const coordinates = repositoryCoordinates(owner, repository)
  const dateRange = `${range.from.slice(0, 10)}..${range.to.slice(0, 10)}`
  const [commits, issues, releases, hotPullRequests] = await Promise.all([
    githubFetch(settings, `/repos/${coordinates.owner}/${coordinates.repository}/commits`, { since: range.from, until: range.to, sha: branch || undefined, per_page: 100 }),
    githubFetch(settings, '/search/issues', { q: `repo:${coordinates.fullName} is:issue updated:${dateRange}`, sort: 'updated', order: 'desc', per_page: 50 }),
    githubFetch(settings, `/repos/${coordinates.owner}/${coordinates.repository}/releases`, { per_page: 30 }),
    collectHotPullRequests(settings, owner, repository, range, 10, branch),
  ])
  return {
    repository: branch ? `${coordinates.fullName}@${branch}` : coordinates.fullName,
    repositoryKey: `github:github.com/${coordinates.fullName}@${branch || 'default'}`,
    sourceType: 'github',
    branch: branch || '',
    range,
    collectedAt: new Date().toISOString(),
    counts: {
      commits: commits.length,
      pullRequests: hotPullRequests.length,
      issues: issues.total_count || issues.items?.length || 0,
      releases: releases.filter((release) => release.published_at >= range.from && release.published_at <= range.to).length,
    },
    commits: commits.slice(0, 100).map((commit) => ({ sha: commit.sha.slice(0, 12), message: trimText(commit.commit?.message?.split('\n')[0], 500), author: commit.author?.login || commit.commit?.author?.name || '', date: commit.commit?.author?.date, url: commit.html_url })),
    hotPullRequests,
    issues: (issues.items || []).slice(0, 30).map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, comments: issue.comments, updatedAt: issue.updated_at, url: issue.html_url })),
    releases: releases.filter((release) => release.published_at >= range.from && release.published_at <= range.to).map((release) => ({ name: release.name || release.tag_name, tag: release.tag_name, publishedAt: release.published_at, url: release.html_url })),
  }
}
