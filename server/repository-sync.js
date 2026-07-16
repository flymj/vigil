import { execFile } from 'node:child_process'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function gitEnvironment(settings, source) {
  const environment = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
  }
  const inheritedConfigCount = Number(process.env.GIT_CONFIG_COUNT)
  const configIndex = Number.isInteger(inheritedConfigCount) && inheritedConfigCount >= 0 ? inheritedConfigCount : 0
  if (source.sourceType === 'gerrit') {
    const username = settings.gerrit?.usernameEnv ? process.env[settings.gerrit.usernameEnv] : ''
    const password = settings.gerrit?.passwordEnv ? process.env[settings.gerrit.passwordEnv] : ''
    if (username && password) {
      environment.GIT_CONFIG_COUNT = String(configIndex + 1)
      environment[`GIT_CONFIG_KEY_${configIndex}`] = `http.${source.apiBaseUrl}/.extraHeader`
      environment[`GIT_CONFIG_VALUE_${configIndex}`] = `Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    }
  } else {
    const { loadGitHubApiKey } = await import('./github-secret.js')
    const token = await loadGitHubApiKey()
    if (token) {
      environment.GIT_CONFIG_COUNT = String(configIndex + 1)
      environment[`GIT_CONFIG_KEY_${configIndex}`] = 'http.https://github.com/.extraHeader'
      environment[`GIT_CONFIG_VALUE_${configIndex}`] = `Authorization: Bearer ${token}`
    }
  }
  return environment
}

async function git(args, settings, source, timeout = 20 * 60 * 1000) {
  const result = await execFileAsync('git', args, {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: await gitEnvironment(settings, source),
  })
  return result.stdout.trim()
}

export async function syncFullRepository(settings, source) {
  const parentDirectory = path.join(settings.workspace.directory, 'repositories', 'full')
  const localPath = path.join(parentDirectory, source.id)
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 })

  if (!await exists(path.join(localPath, '.git'))) {
    if (await exists(localPath)) throw new Error(`Full sync target exists but is not a Git working copy: ${localPath}`)
    const temporaryPath = `${localPath}.clone-${process.pid}`
    await rm(temporaryPath, { recursive: true, force: true })
    try {
      await git(['clone', source.cloneUrl, temporaryPath], settings, source)
      await rename(temporaryPath, localPath)
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true })
      throw error
    }
  } else {
    await git(['-C', localPath, 'remote', 'set-url', 'origin', source.cloneUrl], settings, source)
    await git(['-C', localPath, 'fetch', '--prune', '--tags', 'origin'], settings, source)
  }

  const localBranch = await git(['-C', localPath, 'show-ref', '--verify', '--quiet', `refs/heads/${source.branch}`], settings, source)
    .then(() => true)
    .catch(() => false)
  if (localBranch) {
    await git(['-C', localPath, 'checkout', source.branch], settings, source)
  } else {
    await git(['-C', localPath, 'checkout', '-b', source.branch, '--track', `origin/${source.branch}`], settings, source)
  }
  await git(['-C', localPath, 'merge', '--ff-only', `origin/${source.branch}`], settings, source)
  const headSha = await git(['-C', localPath, 'rev-parse', 'HEAD'], settings, source)
  return { localPath, branch: source.branch, headSha, syncedAt: new Date().toISOString() }
}
