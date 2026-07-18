const terminalOutcomes = new Set(['findings', 'state_updated', 'no_finding', 'duplicate_only', 'blocked_incomplete_sources'])

export function dreamCollectionState({ loading = false, error = '', dream = null, total = 0 } = {}) {
  if (loading) return 'loading'
  if (error) return 'error'
  if (!dream?.enabled) return 'disabled'
  if (!dream?.ready) return 'unavailable'
  if (dream.currentRun) return total > 0 ? 'refreshing' : 'running'
  if (!dream.lastRun) return 'never_run'
  if (total > 0) return 'ready'
  if (dream.lastRun.status === 'blocked') return 'blocked'
  if (dream.lastRun.status === 'failed') return 'failed'
  if (dream.lastRun.outcome === 'no_finding' || dream.lastRun.outcome === 'duplicate_only') return 'no_finding'
  return terminalOutcomes.has(dream.lastRun.outcome) ? 'empty' : 'empty'
}

export function percentScore(value) {
  const score = Number(value)
  if (!Number.isFinite(score)) return 0
  return Math.round(Math.max(0, Math.min(1, score)) * 100)
}

export function forecastTone(forecast) {
  if (!forecast || forecast.status === 'open') {
    if (forecast?.dueAt && new Date(forecast.dueAt).getTime() < Date.now()) return 'overdue'
    return 'open'
  }
  if (forecast.status === 'confirmed') return 'confirmed'
  if (forecast.status === 'refuted') return 'refuted'
  return 'inconclusive'
}

export function runOutcomeLabel(run) {
  if (!run) return '尚未运行'
  const labels = {
    findings: '发现新技术点',
    state_updated: '已修正已知判断',
    no_finding: '未发现新技术点',
    duplicate_only: '候选已在已知账本',
    blocked_incomplete_sources: '证据源不完整',
  }
  return labels[run.outcome] || run.outcome || run.status || '未知'
}

export function formatDreamTime(value, locale = 'zh-CN') {
  if (!value) return '—'
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return '—'
  return timestamp.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}
