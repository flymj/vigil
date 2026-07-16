import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, '--').slice(0, 180)
}

function reportPaths(settings, id) {
  const directory = path.join(settings.workspace.directory, 'artifacts', 'windows', safeSegment(id))
  return {
    directory,
    jsonPath: path.join(directory, 'window.json'),
    markdownPath: path.join(directory, 'window.md'),
    artifactId: id,
  }
}

async function writeAtomically(target, contents) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, contents, { mode: 0o600 })
  await rename(temporary, target)
}

function outcomeLine(run) {
  if (run.status === 'succeeded') {
    const counts = run.counts || {}
    return `- ${run.repository}: succeeded · ${counts.commits || 0} commits · ${counts.pullRequests || 0} PRs · ${counts.issues || 0} issues · ${counts.releases || 0} releases`
  }
  return `- ${run.repository}: failed · ${run.error || 'Unknown error'}`
}

export function structuredWindowSummary(window) {
  const successful = window.repositoryRuns.filter((run) => run.status === 'succeeded')
  const failed = window.repositoryRuns.filter((run) => run.status === 'failed')
  return {
    mode: 'structured',
    content: [
      `## Window ${window.rangeStart} 至 ${window.rangeEnd}`,
      '',
      `状态：${window.status}。成功 ${successful.length} 个仓库，失败 ${failed.length} 个仓库。`,
      '',
      '### 仓库结果',
      ...(window.repositoryRuns.length ? window.repositoryRuns.map(outcomeLine) : ['- 当前 Window 没有可处理的观察仓库。']),
    ].join('\n'),
    model: null,
    latencyMs: 0,
  }
}

function windowMarkdown(record, report) {
  return [
    `# Vigil Window ${record.id}`,
    '',
    `- From: ${record.rangeStart}`,
    `- To: ${record.rangeEnd}`,
    `- Timezone: ${record.timezone}`,
    `- Status: ${record.status}`,
    `- Generated: ${report.generatedAt}`,
    `- Analysis mode: ${report.analysis.mode}`,
    '',
    '## Repository outcomes',
    '',
    ...(record.repositoryRuns.length ? record.repositoryRuns.map(outcomeLine) : ['- No watched repositories were processed.']),
    '',
    report.analysis.content,
    '',
  ].join('\n')
}

export async function persistWindowReport(settings, record, report) {
  const paths = reportPaths(settings, record.id)
  const payload = {
    id: record.id,
    rangeStart: record.rangeStart,
    rangeEnd: record.rangeEnd,
    timezone: record.timezone,
    status: record.status,
    repositoryRuns: record.repositoryRuns,
    generatedAt: report.generatedAt,
    analysis: report.analysis,
  }
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  await writeAtomically(paths.jsonPath, `${JSON.stringify(payload, null, 2)}\n`)
  await writeAtomically(paths.markdownPath, windowMarkdown(record, report))
  return paths
}

export async function loadWindowArtifact(settings, id, format = 'markdown') {
  const paths = reportPaths(settings, id)
  const target = format === 'json' ? paths.jsonPath : paths.markdownPath
  try {
    await readFile(target, 'utf8')
    return { ...paths, format: format === 'json' ? 'json' : 'markdown', path: target }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
