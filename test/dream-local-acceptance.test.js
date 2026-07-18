import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('local acceptance rejects a non-dedicated cleanup root before mutation', () => {
  const root = '/tmp/vigil-unsafe-acceptance-root'
  const result = spawnSync(process.execPath, ['scripts/dream-local-acceptance.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      VIGIL_ACCEPTANCE_ROOT: root,
      VIGIL_CONFIG_DIR: `${root}/config`,
      VIGIL_ACCEPTANCE_SOURCE_CONFIG: '/tmp/vigil-source-config-outside-root',
    },
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /dedicated vigil-dream-acceptance/)
})
