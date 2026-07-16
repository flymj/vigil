import assert from 'node:assert/strict'
import test from 'node:test'

import { getWindow, getWindows, retryWindow, subscribeToWindowEvents, triggerWindow, windowDownloadUrl } from '../src/api.js'

test('Window API client uses the durable archive, retry, and trigger endpoints', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (path, options = {}) => {
    requests.push({ path, options })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    await getWindows()
    await getWindow('window/one')
    await triggerWindow('2026-07-16T00:00:00.000Z')
    await retryWindow('window/one')

    assert.deepEqual(requests.map(({ path, options }) => [path, options.method || 'GET']), [
      ['/api/windows', 'GET'],
      ['/api/windows/window%2Fone', 'GET'],
      ['/api/windows/trigger', 'POST'],
      ['/api/windows/window%2Fone/retry', 'POST'],
    ])
    assert.equal(requests[2].options.body, JSON.stringify({ rangeEnd: '2026-07-16T00:00:00.000Z' }))
    assert.equal(windowDownloadUrl('window/one', 'json'), '/api/windows/window%2Fone/download?format=json')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Window SSE client parses events and closes its EventSource subscription', () => {
  const originalEventSource = globalThis.EventSource
  const listeners = new Map()
  let closed = false
  globalThis.EventSource = class FakeEventSource {
    constructor(url) { this.url = url }
    addEventListener(type, listener) { listeners.set(type, listener) }
    close() { closed = true }
  }
  try {
    const events = []
    const unsubscribe = subscribeToWindowEvents('window/one', (event) => events.push(event))
    listeners.get('window')({ data: JSON.stringify({ sequence: 1, type: 'window.started' }) })

    assert.deepEqual(events, [{ sequence: 1, type: 'window.started' }])
    unsubscribe()
    assert.equal(closed, true)
  } finally {
    globalThis.EventSource = originalEventSource
  }
})
