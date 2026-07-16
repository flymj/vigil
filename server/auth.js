import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { configDirectory } from './config.js'

const scrypt = promisify(scryptCallback)
const sessionLifetimeSeconds = 12 * 60 * 60
const sessions = new Map()

function usersPath() {
  return path.join(configDirectory, 'users.json')
}

function validUsername(value) {
  return /^[A-Za-z0-9_.-]{3,80}$/.test(String(value || ''))
}

function validateBootstrapCredentials(username, password) {
  if (!validUsername(username)) throw new Error('VIGIL_ADMIN_USERNAME must be 3-80 characters: letters, numbers, dot, underscore, or hyphen')
  if (typeof password !== 'string' || password.length < 12) throw new Error('VIGIL_ADMIN_PASSWORD must be at least 12 characters')
}

async function readUsers() {
  try {
    const payload = JSON.parse(await readFile(usersPath(), 'utf8'))
    return Array.isArray(payload.users) ? payload.users : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function writeUsers(users) {
  await mkdir(configDirectory, { recursive: true, mode: 0o700 })
  const target = usersPath()
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify({ version: 1, users }, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

async function passwordRecord(password) {
  const salt = randomBytes(16).toString('base64url')
  const derived = await scrypt(password, salt, 64)
  return { salt, hash: derived.toString('base64url') }
}

async function passwordMatches(password, record) {
  if (!record?.salt || !record?.hash || typeof password !== 'string') return false
  const expected = Buffer.from(record.hash, 'base64url')
  const derived = await scrypt(password, record.salt, expected.length)
  return expected.length === derived.length && timingSafeEqual(expected, derived)
}

export async function ensureBootstrapAdmin() {
  const users = await readUsers()
  if (users.length) return { configured: true, bootstrapped: false }

  const username = process.env.VIGIL_ADMIN_USERNAME
  const password = process.env.VIGIL_ADMIN_PASSWORD
  if (!username && !password) return { configured: false, bootstrapped: false }
  validateBootstrapCredentials(username, password)
  const credentials = await passwordRecord(password)
  await writeUsers([{ id: randomBytes(12).toString('base64url'), username, role: 'admin', ...credentials, createdAt: new Date().toISOString() }])
  return { configured: true, bootstrapped: true }
}

export async function hasConfiguredAdmin() {
  return (await readUsers()).some((user) => user.role === 'admin')
}

function cookieValue(request, name) {
  const cookie = String(request.headers.cookie || '')
  const pair = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : ''
}

function sessionFromRequest(request) {
  const token = cookieValue(request, 'vigil_session')
  const session = sessions.get(token)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token)
    return null
  }
  return session
}

export async function authenticationStatus(request) {
  const users = await readUsers()
  const session = sessionFromRequest(request)
  return { setupRequired: users.length === 0, authenticated: Boolean(session), user: session ? { username: session.username, role: session.role } : null }
}

export async function authenticate(username, password) {
  const users = await readUsers()
  const user = users.find((candidate) => candidate.username === username && candidate.role === 'admin')
  if (!user || !(await passwordMatches(password, user))) return null
  return { id: user.id, username: user.username, role: user.role }
}

export function createSession(user) {
  const token = randomBytes(32).toString('base64url')
  sessions.set(token, { ...user, expiresAt: Date.now() + sessionLifetimeSeconds * 1000 })
  return token
}

export function destroySession(request) {
  const token = cookieValue(request, 'vigil_session')
  if (token) sessions.delete(token)
}

export function sessionCookie(token) {
  const secure = process.env.VIGIL_SESSION_SECURE === 'true' ? '; Secure' : ''
  return `vigil_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${sessionLifetimeSeconds}${secure}`
}

export function expiredSessionCookie() {
  const secure = process.env.VIGIL_SESSION_SECURE === 'true' ? '; Secure' : ''
  return `vigil_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure}`
}

export function requireAuthenticatedAdmin(request, response, next) {
  const session = sessionFromRequest(request)
  if (!session || session.role !== 'admin') return response.status(401).json({ error: 'Authentication required' })
  request.auth = session
  return next()
}
