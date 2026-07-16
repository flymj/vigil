import { access, mkdir } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { parseRepositoryAddress } from './repository-source.js'

const execFileAsync = promisify(execFile)

function pullRequestNumber(change) {
  const evidence = [change.title, change.summary, ...(change.facts || [])].join(' ')
  const match = evidence.match(/(?:PR|pull request)\s*#(\d+)/i)
  return match ? Number(match[1]) : null
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function git(args, options = {}) {
  const result = await execFileAsync('git', args, {
    timeout: options.timeout || 180000,
    maxBuffer: options.maxBuffer || 12 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return result.stdout.trim()
}

async function gitBounded(args, byteLimit) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    const chunks = []
    const errors = []
    let captured = 0
    let truncated = false
    const timeout = setTimeout(() => child.kill('SIGTERM'), 180000)

    child.stdout.on('data', (chunk) => {
      const remaining = byteLimit - captured
      if (remaining > 0) {
        const slice = chunk.subarray(0, remaining)
        chunks.push(slice)
        captured += slice.length
      }
      if (chunk.length > remaining) truncated = true
    })
    child.stderr.on('data', (chunk) => {
      if (Buffer.concat(errors).length < 65536) errors.push(chunk)
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`git exited with ${code ?? signal}: ${Buffer.concat(errors).toString('utf8').slice(0, 1000)}`))
        return
      }
      resolve({ stdout: Buffer.concat(chunks).toString('utf8').trim(), truncated })
    })
  })
}

export async function prepareRepositoryContext(change, settings) {
  if (settings.repositoryContext.strategy !== 'git-mirror') {
    return { changedFiles: [], diff: '', meta: { strategy: 'api-only', status: 'skipped' } }
  }

  const source = typeof change.repository === 'object'
    ? change.repository
    : parseRepositoryAddress(change.repository)
  const pullRequest = pullRequestNumber(change)
  const repositoriesDirectory = path.join(settings.workspace.directory, 'repositories')
  const mirrorName = `${source.sourceType}--${source.host}--${source.project}`.replace(/[^A-Za-z0-9_.-]+/g, '--')
  const mirrorPath = path.join(repositoriesDirectory, `${mirrorName}.git`)
  const remote = source.cloneUrl
  await mkdir(repositoriesDirectory, { recursive: true, mode: 0o700 })

  const alreadyCloned = await exists(mirrorPath)
  if (!alreadyCloned) {
    await git(['clone', '--mirror', '--filter=blob:none', remote, mirrorPath], { timeout: 600000 })
  } else if (settings.repositoryContext.fetchOnDeepDive) {
    await git([`--git-dir=${mirrorPath}`, 'fetch', '--prune', 'origin'], { timeout: 300000 })
  }

  const branch = change.branch || source.branch || 'HEAD'
  let comparison = branch === 'HEAD' ? 'HEAD^..HEAD' : `${branch}^..${branch}`
  if (source.sourceType === 'github' && pullRequest) {
    const pullRequestRef = `refs/vigil/pr/${pullRequest}`
    await git([
      `--git-dir=${mirrorPath}`,
      'fetch',
      'origin',
      `+refs/pull/${pullRequest}/head:${pullRequestRef}`,
    ], { timeout: 300000 })
    comparison = `HEAD...${pullRequestRef}`
  } else if (source.sourceType === 'gerrit' && change.changeRef) {
    const changeRef = 'refs/vigil/gerrit-change'
    await git([
      `--git-dir=${mirrorPath}`,
      'fetch',
      'origin',
      `+${change.changeRef}:${changeRef}`,
    ], { timeout: 300000 })
    comparison = `${branch}...${changeRef}`
  }

  const names = await git([`--git-dir=${mirrorPath}`, 'diff', '--name-only', comparison])
  const changedFiles = names.split('\n').filter(Boolean).slice(0, settings.deepDive.maxContextFiles)
  const diffResult = changedFiles.length
    ? await gitBounded([
        `--git-dir=${mirrorPath}`,
        'diff',
        '--no-ext-diff',
        '--unified=30',
        comparison,
        '--',
        ...changedFiles,
      ], settings.deepDive.maxDiffBytes)
    : { stdout: '', truncated: false }

  return {
    changedFiles,
    diff: diffResult.stdout,
    meta: {
      strategy: 'git-mirror',
      status: alreadyCloned ? 'fetched' : 'cloned',
      repository: `${source.project}@${branch}`,
      sourceType: source.sourceType,
      pullRequest,
      changedFileCount: names.split('\n').filter(Boolean).length,
      includedFileCount: changedFiles.length,
      diffTruncated: diffResult.truncated,
      comparison,
    },
  }
}
