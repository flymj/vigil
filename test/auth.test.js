import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const directory = await mkdtemp(path.join(os.tmpdir(), 'vigil-auth-'))
process.env.VIGIL_CONFIG_DIR = directory
process.env.VIGIL_ADMIN_USERNAME = 'vigil-admin'
process.env.VIGIL_ADMIN_PASSWORD = 'a-test-password-with-12-characters'

const {
  authenticate,
  authenticationStatus,
  createSession,
  ensureBootstrapAdmin,
  sessionCookie,
} = await import('../server/auth.js')

test('bootstraps an admin from server-only environment variables and authenticates a session', async () => {
  try {
    const result = await ensureBootstrapAdmin()
    assert.equal(result.bootstrapped, true)

    const stored = await readFile(path.join(directory, 'users.json'), 'utf8')
    assert.equal(stored.includes(process.env.VIGIL_ADMIN_PASSWORD), false)

    assert.equal(await authenticate('vigil-admin', 'wrong-password'), null)
    const user = await authenticate('vigil-admin', process.env.VIGIL_ADMIN_PASSWORD)
    assert.deepEqual(user, { id: user.id, username: 'vigil-admin', role: 'admin' })

    const cookie = sessionCookie(createSession(user))
    const status = await authenticationStatus({ headers: { cookie } })
    assert.equal(status.setupRequired, false)
    assert.equal(status.authenticated, true)
    assert.deepEqual(status.user, { username: 'vigil-admin', role: 'admin' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
