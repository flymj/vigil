function redactUrlCredentials(value) {
  return value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
}

function redactSensitivePairs(value) {
  return value
    .replace(/\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi, 'Authorization: [REDACTED]')
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+\/=:-]+/gi, (match) => `${match.split(/\s+/)[0]} [REDACTED]`)
    .replace(/\b(?:x-?api-?key|api[_ -]?key|access[_ -]?token|token|password|secret)\s*(?:=|:)\s*[^\s,;&]+/gi, (match) => `${match.split(/\s*(?:=|:)/)[0]}=[REDACTED]`)
}

export function sanitizeWindowText(value, maxLength = 600) {
  if (value === null || value === undefined) return undefined
  return redactSensitivePairs(redactUrlCredentials(String(value))).trim().slice(0, maxLength)
}

export function sanitizeWindowUrl(value) {
  const text = sanitizeWindowText(value, 2_000)
  if (!text) return text
  try {
    const url = new URL(text)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:api[_-]?key|token|password|secret)/i.test(key)) url.searchParams.set(key, '[REDACTED]')
    }
    return url.toString()
  } catch {
    return text
  }
}

export function sanitizeWindowRepository(repository) {
  const allowed = ['id', 'name', 'org', 'initial', 'color', 'weight', 'criticalPaths', 'syncMode', 'syncStatus', 'localPath', 'sourceType', 'host', 'project', 'branch', 'defaultBranch', 'cloneUrl', 'browseUrl', 'apiBaseUrl']
  return Object.fromEntries(allowed
    .filter((key) => repository[key] !== undefined)
    .map((key) => {
      const value = repository[key]
      if (['cloneUrl', 'browseUrl', 'apiBaseUrl'].includes(key)) return [key, sanitizeWindowUrl(value)]
      if (Array.isArray(value)) return [key, value.map((item) => sanitizeWindowText(item, 240)).filter(Boolean)]
      return [key, typeof value === 'string' ? sanitizeWindowText(value, 600) : value]
    }))
}
