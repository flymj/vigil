import assert from 'node:assert/strict'
import test from 'node:test'

import { gerritTimeQuery, parseGerritJson, normalizeGerritChange } from '../server/gerrit.js'

test('parses Gerrit XSSI-prefixed JSON', () => {
  assert.deepEqual(parseGerritJson(")]}'\n[{\"id\":\"project~main~Iabc\"}]"), [
    { id: 'project~main~Iabc' },
  ])
})

test('builds exact Gerrit time bounds for same-day windows', () => {
  assert.equal(
    gerritTimeQuery({ from: '2026-07-16T00:00:00.000Z', to: '2026-07-16T08:00:00.000Z' }),
    'after:"2026-07-16 00:00:00 +0000" before:"2026-07-16 08:00:00 +0000"',
  )
})

test('normalizes a Gerrit Change for the shared hot-change UI', () => {
  const change = normalizeGerritChange({
    id: 'platform%2Fruntime~main~Iabc',
    project: 'platform/runtime',
    branch: 'main',
    subject: 'Refactor scheduler ownership',
    status: 'NEW',
    owner: { username: 'flymj' },
    created: '2026-07-15 10:00:00.000000000',
    updated: '2026-07-16 10:00:00.000000000',
    _number: 12345,
    insertions: 120,
    deletions: 35,
    total_comment_count: 8,
    current_revision: 'deadbeef',
    revisions: { deadbeef: { files: { 'src/runtime.cc': {}, '/COMMIT_MSG': {} } } },
    labels: { 'Code-Review': { all: [{ value: 2 }, { value: 1 }] } },
  }, { apiBaseUrl: 'https://gerrit.example.com' }, new Date('2026-07-16T12:00:00Z').getTime())

  assert.equal(change.number, 12345)
  assert.equal(change.changedFiles, 1)
  assert.equal(change.comments, 8)
  assert.equal(change.reactions, 2)
  assert.match(change.url, /\/c\/platform\/runtime\/\+\/12345$/)
  assert.ok(change.hotScore > 0)
})
