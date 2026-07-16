import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, '--').slice(0, 180)
}

export function structuredRepositorySummary(snapshot) {
  const changeLabel = snapshot.sourceType === 'gerrit' ? 'Change' : 'PR'
  const commitSubjects = snapshot.commits.slice(0, 5).map((commit) => commit.message)
  const hotPullRequests = snapshot.hotPullRequests.slice(0, 5).map((pullRequest) => `#${pullRequest.number} ${pullRequest.title}`)
  const releaseNames = snapshot.releases.map((release) => release.name)
  return {
    mode: 'structured',
    content: [
      `## ${snapshot.repository} 时间段摘要`,
      '',
      `该时间段共采集到 ${snapshot.counts.commits} 个 commit、${snapshot.counts.pullRequests} 个活跃 ${changeLabel}、${snapshot.counts.issues} 个活跃 issue 和 ${snapshot.counts.releases} 个 release。`,
      '',
      '### 主要提交',
      ...(commitSubjects.length ? commitSubjects.map((subject) => `- ${subject}`) : ['- 没有采集到 commit']),
      '',
      `### 热门 ${changeLabel}`,
      ...(hotPullRequests.length ? hotPullRequests.map((item) => `- ${item}`) : ['- 没有采集到活跃 PR']),
      '',
      '### Release',
      ...(releaseNames.length ? releaseNames.map((name) => `- ${name}`) : ['- 本时间段没有 release']),
      '',
      '> 当前为结构化摘要；配置 Provider 后可生成语义影响、风险和待跟踪问题。',
    ].join('\n'),
    model: null,
    latencyMs: 0,
  }
}

function reportPaths(settings, repository, range) {
  const repositoryDirectory = path.join(
    settings.workspace.directory,
    'artifacts',
    'repository-summaries',
    safeSegment(repository),
  )
  const key = `${range.from.replace(/[:.]/g, '-')}_${range.to.replace(/[:.]/g, '-')}`
  return {
    repositoryDirectory,
    jsonPath: path.join(repositoryDirectory, `${key}.json`),
    markdownPath: path.join(repositoryDirectory, `${key}.md`),
    artifactId: `${safeSegment(repository)}/${key}`,
  }
}

function reportMarkdown(report) {
  const snapshot = report.snapshot
  return [
    `# ${snapshot.repository} Repository Intelligence Report`,
    '',
    `- From: ${snapshot.range.from}`,
    `- To: ${snapshot.range.to}`,
    `- Generated: ${report.generatedAt}`,
    `- Source: ${snapshot.sourceType || 'github'}`,
    `- Branch: ${snapshot.branch || 'default'}`,
    `- Commits: ${snapshot.counts.commits}`,
    `- Active PRs: ${snapshot.counts.pullRequests}`,
    `- Issues: ${snapshot.counts.issues}`,
    `- Releases: ${snapshot.counts.releases}`,
    `- Analysis mode: ${report.analysis.mode}`,
    '',
    report.analysis.content,
    '',
    '## Evidence index',
    '',
    ...snapshot.hotPullRequests.map((pullRequest) => `- ${snapshot.sourceType === 'gerrit' ? 'Change' : 'PR'} #${pullRequest.number}: [${pullRequest.title}](${pullRequest.url}) · hot score ${pullRequest.hotScore}`),
    ...snapshot.commits.slice(0, 30).map((commit) => `- Commit [${commit.sha}](${commit.url}): ${commit.message}`),
    '',
  ].join('\n')
}

export async function loadRepositorySummary(settings, repository, range) {
  const paths = reportPaths(settings, repository, range)
  try {
    const report = JSON.parse(await readFile(paths.jsonPath, 'utf8'))
    return { report, ...paths }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function persistRepositorySummary(settings, report) {
  const paths = reportPaths(settings, report.snapshot.repositoryKey || report.snapshot.repository, report.snapshot.range)
  await mkdir(paths.repositoryDirectory, { recursive: true, mode: 0o700 })
  await writeFile(paths.jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(paths.markdownPath, reportMarkdown(report), { mode: 0o600 })
  return paths
}
