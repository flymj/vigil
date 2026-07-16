import { collectGerritWindow, collectHotGerritChanges, snoopGerritChange } from './gerrit.js'
import { collectHotPullRequests, collectRepositoryWindow, snoopPullRequest } from './github.js'
import { normalizeRepositorySource, repositoryIdentity } from './repository-source.js'

function githubCoordinates(source) {
  const parts = source.project.split('/')
  if (parts.length !== 2) throw new Error('GitHub project must use owner/repository')
  return { owner: parts[0], repository: parts[1] }
}

export function repositoryReportKey(sourceValue) {
  return repositoryIdentity(normalizeRepositorySource(sourceValue))
}

export async function collectHotChanges(settings, sourceValue, range, limit = 10) {
  const source = normalizeRepositorySource(sourceValue)
  if (source.sourceType === 'gerrit') return collectHotGerritChanges(settings, source, range, limit)
  const { owner, repository } = githubCoordinates(source)
  return collectHotPullRequests(settings, owner, repository, range, limit, source.branch)
}

export async function snoopChange(settings, sourceValue, changeNumber) {
  const source = normalizeRepositorySource(sourceValue)
  if (source.sourceType === 'gerrit') return snoopGerritChange(settings, source, changeNumber)
  const { owner, repository } = githubCoordinates(source)
  return snoopPullRequest(settings, owner, repository, changeNumber)
}

export async function collectSourceWindow(settings, sourceValue, range) {
  const source = normalizeRepositorySource(sourceValue)
  if (source.sourceType === 'gerrit') return collectGerritWindow(settings, source, range)
  const { owner, repository } = githubCoordinates(source)
  return collectRepositoryWindow(settings, owner, repository, range, source.branch)
}
