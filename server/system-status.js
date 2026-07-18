import { access } from 'node:fs/promises'
import { hasConfiguredAdmin } from './auth.js'
import { githubCredentialStatus, providerCredentialStatus } from './config.js'
import { nextPublishAt, normalizeWindowSchedule } from './window-schedule.js'

export async function collectSystemStatus(settings, repositories, environment = process.env, scheduler = {}, dreamScheduler = {}) {
  let workspaceAvailable = false
  try {
    await access(settings.workspace.directory)
    workspaceAvailable = true
  } catch {
    workspaceAvailable = false
  }

  const githubCredential = await githubCredentialStatus()
  const gerritUsernameConfigured = Boolean(settings.gerrit.usernameEnv && environment[settings.gerrit.usernameEnv])
  const gerritPasswordConfigured = Boolean(settings.gerrit.passwordEnv && environment[settings.gerrit.passwordEnv])
  const providerCredential = await providerCredentialStatus(settings)
  const windowSchedule = normalizeWindowSchedule(settings.windowSchedule)
  const scheduled = windowSchedule.enabled

  return {
    checkedAt: new Date().toISOString(),
    api: { available: true },
    workspace: {
      directory: settings.workspace.directory,
      available: workspaceAvailable,
    },
    repositories: {
      total: repositories.length,
      github: repositories.filter((repository) => repository.sourceType === 'github').length,
      gerrit: repositories.filter((repository) => repository.sourceType === 'gerrit').length,
      fullSyncReady: repositories.filter((repository) => repository.syncMode === 'full' && repository.syncStatus === 'ready').length,
      fullSyncFailed: repositories.filter((repository) => repository.syncMode === 'full' && repository.syncStatus === 'failed').length,
    },
    collection: {
      mode: scheduled ? 'scheduled' : 'on-demand',
      scheduled,
      timezone: windowSchedule.timezone,
      publishTimes: windowSchedule.publishTimes,
      nextPublishAt: scheduled ? scheduler.nextPublishAt || nextPublishAt(windowSchedule) : null,
      currentWindow: scheduler.currentRun || null,
      lastWindow: scheduler.lastWindow || null,
      githubTokenConfigured: githubCredential.apiKeyConfigured,
      gerritCredentialsConfigured: gerritUsernameConfigured && gerritPasswordConfigured,
    },
    provider: {
      name: settings.provider.name,
      model: settings.provider.model,
      endpointConfigured: Boolean(settings.provider.baseUrl && settings.provider.model),
      credentialConfigured: providerCredential.apiKeyConfigured,
      credentialRequired: providerCredential.requiresApiKey,
      ready: Boolean(settings.provider.baseUrl && settings.provider.model) && providerCredential.providerReady,
    },
    dream: {
      enabled: Boolean(dreamScheduler.enabled),
      ready: Boolean(dreamScheduler.ready),
      reasons: dreamScheduler.reasons || [],
      timezone: dreamScheduler.timezone || settings.dreamSchedule?.timezone || windowSchedule.timezone,
      nextRunAt: dreamScheduler.nextRunAt || null,
      currentRun: dreamScheduler.currentRun || null,
      lastRun: dreamScheduler.lastRun || null,
      cursor: dreamScheduler.cursor || null,
      versions: dreamScheduler.versions || { signals: 0, topics: 0, evidence: 0 },
    },
    authentication: { configured: await hasConfiguredAdmin() },
    audit: { configured: false },
  }
}
