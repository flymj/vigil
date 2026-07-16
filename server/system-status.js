import { access } from 'node:fs/promises'

function environmentConfigured(name, environment) {
  return Boolean(name && environment[name])
}

export async function collectSystemStatus(settings, repositories, environment = process.env) {
  let workspaceAvailable = false
  try {
    await access(settings.workspace.directory)
    workspaceAvailable = true
  } catch {
    workspaceAvailable = false
  }

  const githubTokenConfigured = environmentConfigured(settings.github.tokenEnv, environment)
  const gerritUsernameConfigured = environmentConfigured(settings.gerrit.usernameEnv, environment)
  const gerritPasswordConfigured = environmentConfigured(settings.gerrit.passwordEnv, environment)
  const providerCredentialConfigured = settings.provider.apiKeyEnv
    ? environmentConfigured(settings.provider.apiKeyEnv, environment)
    : true

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
      mode: 'on-demand',
      scheduled: false,
      githubTokenConfigured,
      gerritCredentialsConfigured: gerritUsernameConfigured && gerritPasswordConfigured,
    },
    provider: {
      name: settings.provider.name,
      model: settings.provider.model,
      endpointConfigured: Boolean(settings.provider.baseUrl && settings.provider.model),
      credentialConfigured: providerCredentialConfigured,
    },
    authentication: { configured: false },
    audit: { configured: false },
  }
}
