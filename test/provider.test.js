import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { executeRepositorySummary, executeWindowSummary } from '../server/provider.js'

test('provider requests never include temperature', async () => {
  const requests = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ model: 'fast', choices: [{ message: { content: 'summary' } }], usage: {} }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const settings = {
    provider: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fast', requiresApiKey: false, timeoutSeconds: 10, maxOutputTokens: 64 },
  }
  try {
    await executeRepositorySummary(settings, { repository: 'owner/repository', range: { from: '2026-07-15T00:00:00.000Z', to: '2026-07-16T00:00:00.000Z' } })
    assert.equal(requests.length, 1)
    assert.equal(Object.hasOwn(requests[0], 'temperature'), false)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('Window provider summaries receive bounded cross-repository evidence', async () => {
  const requests = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ model: 'fast', choices: [{ message: { content: 'window summary' } }], usage: {} }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const settings = { provider: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fast', requiresApiKey: false, timeoutSeconds: 10, maxOutputTokens: 64 } }
  try {
    const summary = await executeWindowSummary(settings, {
      rangeStart: '2026-07-16T00:00:00.000Z',
      rangeEnd: '2026-07-16T08:00:00.000Z',
      timezone: 'Asia/Shanghai',
      repositoryRuns: [{
        repository: 'owner/repository',
        status: 'succeeded',
        snapshot: { counts: { commits: 1 }, hotPullRequests: Array.from({ length: 8 }, (_, number) => ({ number })) },
        report: { analysis: { content: 'x'.repeat(7000) } },
        token: 'must-not-reach-provider',
      }],
    })
    const prompt = requests[0].messages.at(-1).content
    assert.equal(summary.content, 'window summary')
    assert.equal(Object.hasOwn(requests[0], 'temperature'), false)
    assert.equal(prompt.includes('must-not-reach-provider'), false)
    assert.equal(prompt.includes('"number": 5'), false)
    assert.equal(prompt.includes('"number": 4'), true)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
