import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const configDirectory = process.env.VIGIL_CONFIG_DIR || path.join(process.cwd(), '.vigil')
const configPath = path.join(configDirectory, 'analysis.json')

export const defaultAnalysisSettings = {
  workspace: {
    directory: path.join(process.cwd(), '.vigil', 'workspace'),
  },
  github: {
    apiBaseUrl: 'https://api.github.com',
    tokenEnv: 'GITHUB_TOKEN',
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
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-4.1-mini',
    timeoutSeconds: 120,
    temperature: 0.2,
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
  return {
    workspace: {
      directory: path.resolve(String(workspace.directory || defaultAnalysisSettings.workspace.directory)),
    },
    github: {
      apiBaseUrl: String(github.apiBaseUrl || defaultAnalysisSettings.github.apiBaseUrl).replace(/\/+$/, ''),
      tokenEnv: String(github.tokenEnv ?? defaultAnalysisSettings.github.tokenEnv).trim().slice(0, 120),
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
      apiKeyEnv: String(provider.apiKeyEnv ?? defaultAnalysisSettings.provider.apiKeyEnv).trim().slice(0, 120),
      model: String(provider.model || defaultAnalysisSettings.provider.model).trim().slice(0, 160),
      timeoutSeconds: asNumber(provider.timeoutSeconds, 120, 5, 600),
      temperature: asNumber(provider.temperature, 0.2, 0, 2),
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

export function providerCredentialStatus(settings) {
  const envName = settings.provider.apiKeyEnv
  return {
    apiKeyConfigured: envName ? Boolean(process.env[envName]) : true,
    apiKeyEnv: envName,
  }
}
