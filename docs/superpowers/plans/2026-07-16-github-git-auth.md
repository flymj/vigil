# GitHub Git HTTPS Authentication Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitHub branch inspection and full repository synchronization authenticate valid personal access tokens over Git HTTPS.

**Architecture:** Add a pure GitHub Git-authorization formatter and reuse it in both Git subprocess environment builders. Keep encrypted token storage, repository URL normalization, and GitHub REST Bearer authentication unchanged.

**Tech Stack:** Node.js ESM, `node:test`, Git CLI environment configuration

## Global Constraints

- Git commands must send `Authorization: Basic base64("x-access-token:<token>")` when a token is configured.
- Empty tokens must produce no Git authorization header.
- GitHub REST API calls must continue using Bearer authentication.
- Repository address normalization must remain unchanged.
- Do not modify or stage the user's existing `package-lock.json` change.

---

### Task 1: Format and apply GitHub Git HTTPS credentials

**Files:**
- Create: `server/git-auth.js`
- Create: `test/git-auth.test.js`
- Modify: `server/repository-source.js:1-7, 213-220`
- Modify: `server/repository-sync.js:1-7, 33-40`

**Interfaces:**
- Consumes: a locally decrypted GitHub personal access token string
- Produces: `githubGitAuthorizationHeader(tokenValue: unknown): string`, returning an empty string or a complete HTTP `Authorization` header value

- [x] **Step 1: Write the failing tests**

```js
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
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test test/git-auth.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/git-auth.js`, proving the new credential formatter does not exist yet.

- [x] **Step 3: Implement the minimal formatter**

Create `server/git-auth.js`:

```js
export function githubGitAuthorizationHeader(tokenValue) {
  const token = String(tokenValue || '').trim()
  if (!token) return ''
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
}
```

- [x] **Step 4: Apply the formatter to branch inspection**

Add to `server/repository-source.js`:

```js
import { githubGitAuthorizationHeader } from './git-auth.js'
```

Replace the GitHub header assignment with:

```js
credentialEnvironment[`GIT_CONFIG_VALUE_${configIndex}`] = githubGitAuthorizationHeader(token)
```

- [x] **Step 5: Apply the formatter to full synchronization**

Add to `server/repository-sync.js`:

```js
import { githubGitAuthorizationHeader } from './git-auth.js'
```

Replace the GitHub header assignment with:

```js
environment[`GIT_CONFIG_VALUE_${configIndex}`] = githubGitAuthorizationHeader(token)
```

- [x] **Step 6: Run the focused test and verify GREEN**

Run: `node --test test/git-auth.test.js`

Expected: 2 tests pass, 0 fail.

- [x] **Step 7: Run repository regression tests**

Run: `node --test test/repository-source.test.js test/repository-sync.test.js test/github-secret.test.js`

Expected: all selected tests pass with 0 failures.

- [x] **Step 8: Run full verification**

Run: `npm test && npm run build`

Expected: complete test suite passes and Vite production build exits with status 0.

- [x] **Step 9: Verify the live configured-token path**

Run a local Node probe that loads the encrypted token, calls `inspectRepositoryAddress('git@github.com:sgl-project/sglang.git', settings)`, and prints only the source type, selected default branch, and branch count.

Expected: source type `github`, a non-empty default branch, and a positive branch count without printing the token.

- [x] **Step 10: Commit only the fix files**

```bash
git add server/git-auth.js server/repository-source.js server/repository-sync.js test/git-auth.test.js docs/superpowers/plans/2026-07-16-github-git-auth.md
git commit -m "fix: authenticate GitHub Git operations with PAT"
```

Expected: the existing `package-lock.json` modification remains unstaged.
