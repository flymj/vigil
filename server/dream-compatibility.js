export const DREAM_MINIMUM_NODE = Object.freeze({ major: 24, minor: 15, label: '24.15.0' })

export function supportsDreamNode(version = process.versions.node) {
  const [major = 0, minor = 0] = String(version || '').split('.').map(Number)
  return major > DREAM_MINIMUM_NODE.major || (major === DREAM_MINIMUM_NODE.major && minor >= DREAM_MINIMUM_NODE.minor)
}

let DatabaseSync = null
let sqliteError = null
if (supportsDreamNode()) {
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch (error) {
    sqliteError = error
  }
}

export function dreamRuntimeCompatibility() {
  const nodeReady = supportsDreamNode()
  const sqliteAvailable = typeof DatabaseSync === 'function'
  const reasons = []
  if (!nodeReady) reasons.push(`Dream requires Node.js >= ${DREAM_MINIMUM_NODE.label}; current runtime is ${process.versions.node}`)
  else if (!sqliteAvailable) reasons.push(`Built-in node:sqlite is unavailable: ${sqliteError?.message || 'module could not be loaded'}`)
  return {
    ready: nodeReady && sqliteAvailable,
    nodeVersion: process.versions.node,
    minimumNodeVersion: DREAM_MINIMUM_NODE.label,
    sqliteAvailable,
    reasons,
  }
}

export function requireDreamDatabaseSync() {
  const status = dreamRuntimeCompatibility()
  if (!status.ready) throw new Error(status.reasons.join('; '))
  return DatabaseSync
}
