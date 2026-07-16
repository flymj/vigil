import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { syncFullRepository } from '../server/repository-sync.js'

const execFileAsync = promisify(execFile)

test('full repository sync creates a persistent working copy on the selected branch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vigil-full-sync-'))
  const sourceDirectory = path.join(directory, 'source')
  const remoteDirectory = path.join(directory, 'remote.git')
  const workspaceDirectory = path.join(directory, 'workspace')
  try {
    await execFileAsync('git', ['init', '-b', 'main', sourceDirectory])
    await writeFile(path.join(sourceDirectory, 'README.md'), 'full sync proof\n')
    await execFileAsync('git', ['-C', sourceDirectory, 'add', 'README.md'])
    await execFileAsync('git', ['-C', sourceDirectory, '-c', 'user.name=Vigil Test', '-c', 'user.email=vigil@example.test', 'commit', '-m', 'Initial commit'])
    await execFileAsync('git', ['clone', '--bare', sourceDirectory, remoteDirectory])

    const result = await syncFullRepository(
      { workspace: { directory: workspaceDirectory }, github: {}, gerrit: {} },
      {
        id: 'source-id',
        sourceType: 'gerrit',
        host: 'gerrit.example.test',
        project: 'platform/runtime',
        branch: 'main',
        cloneUrl: remoteDirectory,
      },
    )

    assert.equal(result.branch, 'main')
    assert.equal(await readFile(path.join(result.localPath, 'README.md'), 'utf8'), 'full sync proof\n')
    assert.equal((await execFileAsync('git', ['-C', result.localPath, 'branch', '--show-current'])).stdout.trim(), 'main')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
