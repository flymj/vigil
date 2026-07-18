import { createHash } from 'node:crypto'
import path from 'node:path'

import { sanitizeWindowText, sanitizeWindowUrl } from './window-safety.js'

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex')
}

export function evidenceId(sourceKey) {
  return `ev-${sha256(String(sourceKey)).slice(0, 16)}`
}

export function contextHash(context) {
  const unsigned = { ...context }
  delete unsigned.context_hash
  return sha256(unsigned)
}

export function sanitizeDreamText(value, maxLength = 4_000) {
  if (value === null || value === undefined) return ''
  return sanitizeWindowText(String(value).replaceAll('\0', ''), maxLength) || ''
}

export function sanitizeDreamLocator(value) {
  const text = sanitizeDreamText(value, 2_000)
  if (!text) return ''
  if (/^https?:\/\//i.test(text)) return sanitizeWindowUrl(text)
  if (path.isAbsolute(text) || /^file:/i.test(text)) return '[local artifact]'
  return text
}

export function safeDreamError(error, maxLength = 1_200) {
  return sanitizeDreamText(error?.message || error || 'Unknown Dream error', maxLength) || 'Unknown Dream error'
}

export function boundedText(value, maxLength) {
  const source = sanitizeDreamText(value, Math.max(1, maxLength * 2))
  if (source.length <= maxLength) return { text: source, truncated: false, originalLength: source.length }
  return { text: `${source.slice(0, Math.max(0, maxLength - 1))}…`, truncated: true, originalLength: source.length }
}
