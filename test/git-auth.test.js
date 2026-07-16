import assert from 'node:assert/strict'
import test from 'node:test'

test('formats GitHub PATs as Git HTTPS Basic credentials', async () => {
  const { githubGitAuthorizationHeader } = await import('../server/git-auth.js')
  const token = 'github_pat_regression_value'
  const header = githubGitAuthorizationHeader(token)

  assert.match(header, /^Authorization: Basic /)
  assert.equal(header.includes(token), false)
  assert.equal(
    Buffer.from(header.slice('Authorization: Basic '.length), 'base64').toString('utf8'),
    `x-access-token:${token}`,
  )
})

test('omits the Git authorization header when no token is configured', async () => {
  const { githubGitAuthorizationHeader } = await import('../server/git-auth.js')
  assert.equal(githubGitAuthorizationHeader(''), '')
  assert.equal(githubGitAuthorizationHeader('   '), '')
})
