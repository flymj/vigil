import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { configDirectory } from './config.js'

const keyPath = path.join(configDirectory, 'github-secret.key')
const secretPath = path.join(configDirectory, 'github-secret.json')

async function writePrivateFile(target, contents) {
  await mkdir(configDirectory, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, contents, { mode: 0o600 })
  await rename(temporary, target)
}

async function encryptionKey() {
  try {
    const existing = await readFile(keyPath)
    if (existing.length !== 32) throw new Error('GitHub secret key is invalid')
    return existing
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const generated = randomBytes(32)
    await writePrivateFile(keyPath, generated)
    return generated
  }
}

export async function saveGitHubApiKey(value) {
  const apiKey = String(value || '').trim()
  if (!apiKey) {
    await rm(secretPath, { force: true })
    return { apiKeyConfigured: false }
  }
  const key = await encryptionKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  await writePrivateFile(secretPath, `${JSON.stringify({
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`)
  return { apiKeyConfigured: true }
}

export async function loadGitHubApiKey() {
  try {
    const payload = JSON.parse(await readFile(secretPath, 'utf8'))
    if (payload.version !== 1 || payload.algorithm !== 'aes-256-gcm') throw new Error('GitHub secret format is unsupported')
    const decipher = createDecipheriv('aes-256-gcm', await encryptionKey(), Buffer.from(payload.iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64url')), decipher.final()]).toString('utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

export async function githubApiKeyConfigured() {
  return Boolean(await loadGitHubApiKey())
}
