import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { defaultWindowSchedule, normalizeWindowSchedule } from './window-schedule.js'

export const configDirectory = process.env.VIGIL_CONFIG_DIR || path.join(process.cwd(), '.vigil')
const configPath = path.join(configDirectory, 'analysis.json')

export const defaultAnalysisSettings = {
  workspace: {
    directory: path.join(process.cwd(), '.vigil', 'workspace'),
  },
  github: {
    apiBaseUrl: 'https://api.github.com',
    requestTimeoutSeconds: 30,
  },
  gerrit: {
    usernameEnv: 'GERRIT_USERNAME',
    passwordEnv: 'GERRIT_HTTP_PASSWORD',
    requestTimeoutSeconds: 30,
  },
  provider: {
    name: 'OpenAI compatible',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    model: 'gpt-4.1-mini',
    timeoutSeconds: 120,
    maxOutputTokens: 6000,
  },
  deepDive: {
    enabled: true,
    pullRequests: true,
    releases: true,
    criticalPaths: true,
    attentionThreshold: 80,
    changedLinesThreshold: 500,
    maxContextFiles: 24,
    maxDiffBytes: 2097152,
  },
  repositoryContext: {
    strategy: 'git-mirror',
    fetchOnDeepDive: true,
  },
  digitalHuman: {
    enabled: false,
    bindingRef: '',
    adapter: 'unconfigured',
  },
  windowSchedule: defaultWindowSchedule,
}

function asNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export function normalizeAnalysisSettings(input = {}) {
  const workspace = input.workspace || {}
  const github = input.github || {}
  const gerrit = input.gerrit || {}
  const provider = input.provider || {}
  const deepDive = input.deepDive || {}
  const repositoryContext = input.repositoryContext || {}
  const digitalHuman = input.digitalHuman || {}
  const windowSchedule = input.windowSchedule || {}
  return {
    workspace: {
      directory: path.resolve(String(workspace.directory || defaultAnalysisSettings.workspace.directory)),
    },
    github: {
      apiBaseUrl: String(github.apiBaseUrl || defaultAnalysisSettings.github.apiBaseUrl).replace(/\/+$/, ''),
      requestTimeoutSeconds: asNumber(github.requestTimeoutSeconds, 30, 5, 120),
    },
    gerrit: {
      usernameEnv: String(gerrit.usernameEnv ?? defaultAnalysisSettings.gerrit.usernameEnv).trim().slice(0, 120),
      passwordEnv: String(gerrit.passwordEnv ?? defaultAnalysisSettings.gerrit.passwordEnv).trim().slice(0, 120),
      requestTimeoutSeconds: asNumber(gerrit.requestTimeoutSeconds, 30, 5, 120),
    },
    provider: {
      name: String(provider.name || defaultAnalysisSettings.provider.name).slice(0, 80),
      baseUrl: String(provider.baseUrl || defaultAnalysisSettings.provider.baseUrl).replace(/\/+$/, ''),
      requiresApiKey: provider.requiresApiKey !== undefined ? provider.requiresApiKey !== false : provider.apiKeyEnv !== '',
      model: String(provider.model || defaultAnalysisSettings.provider.model).trim().slice(0, 160),
      timeoutSeconds: asNumber(provider.timeoutSeconds, 120, 5, 600),
      maxOutputTokens: asNumber(provider.maxOutputTokens, 6000, 256, 64000),
    },
    deepDive: {
      enabled: deepDive.enabled !== false,
      pullRequests: deepDive.pullRequests !== false,
      releases: deepDive.releases !== false,
      criticalPaths: deepDive.criticalPaths !== false,
      attentionThreshold: asNumber(deepDive.attentionThreshold, 80, 0, 100),
      changedLinesThreshold: asNumber(deepDive.changedLinesThreshold, 500, 1, 1000000),
      maxContextFiles: asNumber(deepDive.maxContextFiles, 24, 1, 500),
      maxDiffBytes: asNumber(deepDive.maxDiffBytes, 2097152, 1024, 104857600),
    },
    repositoryContext: {
      strategy: repositoryContext.strategy === 'api-only' ? 'api-only' : 'git-mirror',
      fetchOnDeepDive: repositoryContext.fetchOnDeepDive !== false,
    },
    digitalHuman: {
      enabled: digitalHuman.enabled === true,
      bindingRef: String(digitalHuman.bindingRef || '').trim().slice(0, 240),
      adapter: 'unconfigured',
    },
    windowSchedule: normalizeWindowSchedule(windowSchedule),
  }
}

export async function loadAnalysisSettings() {
  try {
    const contents = await readFile(configPath, 'utf8')
    return normalizeAnalysisSettings(JSON.parse(contents))
  } catch (error) {
    if (error.code === 'ENOENT') return defaultAnalysisSettings
    throw error
  }
}

export async function saveAnalysisSettings(settings) {
  const normalized = normalizeAnalysisSettings(settings)
  await mkdir(configDirectory, { recursive: true, mode: 0o700 })
  await mkdir(path.join(normalized.workspace.directory, 'repositories'), { recursive: true, mode: 0o700 })
  await mkdir(path.join(normalized.workspace.directory, 'artifacts'), { recursive: true, mode: 0o700 })
  await writeFile(configPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 })
  return normalized
}

export async function providerCredentialStatus(settings) {
  const { providerApiKeyConfigured } = await import('./provider-secret.js')
  const apiKeyConfigured = await providerApiKeyConfigured()
  return {
    apiKeyConfigured,
    requiresApiKey: settings.provider.requiresApiKey,
    providerReady: !settings.provider.requiresApiKey || apiKeyConfigured,
  }
}

export async function githubCredentialStatus() {
  const { githubApiKeyConfigured } = await import('./github-secret.js')
  return { apiKeyConfigured: await githubApiKeyConfigured() }
}
