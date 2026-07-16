import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

import { githubGitAuthorizationHeader } from './git-auth.js'

const execFileAsync = promisify(execFile)

function cleanProject(value) {
  const project = decodeURIComponent(String(value || ''))
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
  if (!project || project.includes('..') || /[\u0000-\u001f]/.test(project)) {
    throw new Error('无法识别仓库项目路径')
  }
  return project
}

function gerritProjectFromPath(pathname) {
  const path = pathname.replace(/^\/+|\/+$/g, '')
  const changeMatch = path.match(/^c\/(.+?)\/\+\/\d+(?:\/\d+)?$/)
  if (changeMatch) return cleanProject(changeMatch[1])
  const adminMatch = path.match(/^admin\/repos\/(.+)$/)
  if (adminMatch) return cleanProject(adminMatch[1])
  return cleanProject(path.replace(/^a\//, ''))
}

function githubSource(project) {
  return {
    sourceType: 'github',
    host: 'github.com',
    project,
    cloneUrl: `https://github.com/${project}.git`,
    browseUrl: `https://github.com/${project}`,
    apiBaseUrl: 'https://api.github.com',
  }
}

function isGithubHost(host) {
  return String(host || '').trim().toLowerCase() === 'github.com'
}

function gerritSource({ host, project, cloneUrl, protocol = 'https:' }) {
  const webProtocol = protocol === 'http:' ? 'http:' : 'https:'
  const apiBaseUrl = `${webProtocol}//${host}`
  return {
    sourceType: 'gerrit',
    host,
    project,
    cloneUrl,
    browseUrl: `${apiBaseUrl}/admin/repos/${project}`,
    apiBaseUrl,
  }
}

export function parseRepositoryAddress(addressValue) {
  const address = String(addressValue || '').trim()
  if (!address) throw new Error('请输入 GitHub 或 Gerrit 仓库地址')

  const shortGithub = address.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/)
  if (shortGithub) return githubSource(`${shortGithub[1]}/${shortGithub[2]}`)

  const scpLike = address.match(/^(?:([^@\s]+)@)?([^:/\s]+):(.+)$/)
  if (scpLike && !address.includes('://')) {
    const [, user, host, rawProject] = scpLike
    const project = cleanProject(rawProject)
    if (isGithubHost(host)) {
      if (project.split('/').length !== 2) throw new Error('GitHub 地址必须包含 owner/repository')
      return githubSource(project)
    }
    return gerritSource({
      host,
      project,
      cloneUrl: `${user ? `${user}@` : ''}${host}:${project}`,
    })
  }

  let url
  try {
    url = new URL(address)
  } catch {
    throw new Error('请输入完整的 GitHub/Gerrit URL、SSH clone 地址或 owner/repository')
  }

  if (!['http:', 'https:', 'ssh:'].includes(url.protocol)) {
    throw new Error(`暂不支持 ${url.protocol} 仓库地址`)
  }
  const hostname = url.hostname.toLowerCase()
  if (isGithubHost(hostname)) {
    const project = cleanProject(url.pathname)
    if (project.split('/').length !== 2) throw new Error('GitHub 地址必须包含 owner/repository')
    return githubSource(project)
  }

  const project = gerritProjectFromPath(url.pathname)
  const host = url.protocol === 'ssh:' ? hostname : url.host.toLowerCase()
  const cloneUrl = url.protocol === 'ssh:'
    ? address.replace(/\/$/, '')
    : `${url.protocol}//${url.host}/${project}`
  return gerritSource({ host, project, cloneUrl, protocol: url.protocol })
}

export function repositoryIdentity(sourceValue) {
  const source = normalizeRepositorySource(sourceValue)
  return `${source.sourceType}:${source.host}/${source.project}@${source.branch}`
}

export function normalizeRepositorySource(sourceValue = {}) {
  if (sourceValue.sourceType && !['github', 'gerrit'].includes(sourceValue.sourceType)) {
    throw new Error('Repository source type must be github or gerrit')
  }
  const declaredSourceType = sourceValue.sourceType === 'gerrit' ? 'gerrit' : 'github'
  const declaredHost = String(sourceValue.host || (declaredSourceType === 'github' ? 'github.com' : '')).trim().toLowerCase()
  // Older Vigil versions parsed git@github.com:owner/repository as Gerrit.
  // Treat those persisted records as GitHub so existing watchlists self-heal.
  const sourceType = declaredSourceType === 'gerrit' && isGithubHost(declaredHost) ? 'github' : declaredSourceType
  const host = sourceType === 'github' ? 'github.com' : declaredHost
  const project = cleanProject(sourceValue.project)
  const branch = String(sourceValue.branch || '').trim()
  if (!host) throw new Error('Repository host is required')
  const invalidBranch = !branch
    || branch.startsWith('-')
    || branch === '@'
    || branch.includes('..')
    || branch.includes('@{')
    || branch.includes('//')
    || branch.endsWith('/')
    || branch.endsWith('.')
    || /[\u0000-\u0020~^:?*[\\]/.test(branch)
    || branch.split('/').some((segment) => segment.startsWith('.') || segment.endsWith('.lock'))
  if (invalidBranch) {
    throw new Error('A valid repository branch is required')
  }
  let parsed
  if (sourceType === 'github') {
    parsed = githubSource(project)
  } else if (sourceValue.cloneUrl) {
    const cloneUrl = String(sourceValue.cloneUrl).trim()
    if (cloneUrl.startsWith('-')) throw new Error('Repository clone URL cannot start with an option')
    const absoluteUrl = cloneUrl.includes('://')
    if (absoluteUrl) {
      let url
      try {
        url = new URL(cloneUrl)
      } catch {
        throw new Error('Repository clone URL is invalid')
      }
      if (!['http:', 'https:', 'ssh:'].includes(url.protocol)) throw new Error('Repository clone URL must use HTTP(S) or SSH')
      if (url.hostname.toLowerCase() !== host.split(':')[0]) throw new Error('Repository clone URL host does not match the repository host')
    } else {
      const scp = cloneUrl.match(/^(?:[^@\s]+@)?([^:/\s]+):(.+)$/)
      if (!scp || scp[1].toLowerCase() !== host.split(':')[0]) throw new Error('Repository clone URL must be a valid Gerrit SSH address')
    }
    const apiBaseUrl = String(sourceValue.apiBaseUrl || `https://${host}`).replace(/\/+$/, '')
    let apiUrl
    try {
      apiUrl = new URL(apiBaseUrl)
    } catch {
      throw new Error('Gerrit API base URL is invalid')
    }
    if (!['http:', 'https:'].includes(apiUrl.protocol) || apiUrl.host.toLowerCase() !== host) {
      throw new Error('Gerrit API base URL must use the repository host')
    }
    parsed = {
      sourceType,
      host,
      project,
      cloneUrl,
      browseUrl: String(sourceValue.browseUrl || `${apiBaseUrl}/admin/repos/${project}`),
      apiBaseUrl,
    }
  } else {
    parsed = gerritSource({ host, project, cloneUrl: `https://${host}/${project}` })
  }
  const identity = `${sourceType}:${host}/${project}@${branch}`
  return {
    ...parsed,
    branch,
    defaultBranch: String(sourceValue.defaultBranch || branch),
    id: createHash('sha256').update(identity).digest('hex').slice(0, 20),
  }
}

function parseRemoteHeads(output) {
  let defaultBranch = ''
  const branches = []
  for (const line of output.split('\n')) {
    const symbolic = line.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/)
    if (symbolic) defaultBranch = symbolic[1]
    const head = line.match(/^[0-9a-f]+\s+refs\/heads\/(.+)$/i)
    if (head) branches.push(head[1])
  }
  const uniqueBranches = [...new Set(branches)].sort((left, right) => left.localeCompare(right))
  defaultBranch ||= uniqueBranches.includes('main') ? 'main' : uniqueBranches.includes('master') ? 'master' : uniqueBranches[0]
  return { branches: uniqueBranches, defaultBranch }
}

export async function inspectRepositoryAddress(address, settings = {}) {
  const parsed = parseRepositoryAddress(address)
  const timeoutSeconds = Math.max(
    5,
    Math.min(120, Number(settings?.[parsed.sourceType]?.requestTimeoutSeconds) || 30),
  )
  const credentialEnvironment = {}
  const inheritedConfigCount = Number(process.env.GIT_CONFIG_COUNT)
  const configIndex = Number.isInteger(inheritedConfigCount) && inheritedConfigCount >= 0 ? inheritedConfigCount : 0
  if (parsed.sourceType === 'gerrit') {
    const username = settings.gerrit?.usernameEnv ? process.env[settings.gerrit.usernameEnv] : ''
    const password = settings.gerrit?.passwordEnv ? process.env[settings.gerrit.passwordEnv] : ''
    if (username && password) {
      credentialEnvironment.GIT_CONFIG_COUNT = String(configIndex + 1)
      credentialEnvironment[`GIT_CONFIG_KEY_${configIndex}`] = `http.${parsed.apiBaseUrl}/.extraHeader`
      credentialEnvironment[`GIT_CONFIG_VALUE_${configIndex}`] = `Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    }
  } else {
    const { loadGitHubApiKey } = await import('./github-secret.js')
    const token = await loadGitHubApiKey()
    if (token) {
      credentialEnvironment.GIT_CONFIG_COUNT = String(configIndex + 1)
      credentialEnvironment[`GIT_CONFIG_KEY_${configIndex}`] = 'http.https://github.com/.extraHeader'
      credentialEnvironment[`GIT_CONFIG_VALUE_${configIndex}`] = githubGitAuthorizationHeader(token)
    }
  }
  let stdout
  try {
    const result = await execFileAsync('git', ['ls-remote', '--symref', parsed.cloneUrl, 'HEAD', 'refs/heads/*'], {
      timeout: timeoutSeconds * 1000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
        ...credentialEnvironment,
      },
    })
    stdout = result.stdout
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim().split('\n').slice(-2).join(' · ')
    throw new Error(`无法读取远端分支：${detail || '请检查地址和认证配置'}`)
  }
  const { branches, defaultBranch } = parseRemoteHeads(stdout)
  if (!branches.length) throw new Error('远端没有可选择的 branch，或当前凭据无权读取 refs/heads')
  return {
    ...parsed,
    branch: defaultBranch,
    defaultBranch,
    branches,
  }
}
