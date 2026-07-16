import assert from 'node:assert/strict'
import test from 'node:test'

import { createWindowEventHub } from '../server/window-events.js'

test('a hub subscriber receives newly appended events and can unsubscribe', () => {
  const hub = createWindowEventHub()
  const received = []
  const unsubscribe = hub.subscribe('window-1', (event) => received.push(event))

  hub.publish({ windowId: 'window-1', sequence: 1, type: 'window.started' })
  unsubscribe()
  hub.publish({ windowId: 'window-1', sequence: 2, type: 'window.published' })

  assert.deepEqual(received.map((event) => event.type), ['window.started'])
})

test('one subscriber failure does not block remaining Window listeners', () => {
  const hub = createWindowEventHub()
  const received = []
  hub.subscribe('window-1', () => { throw new Error('disconnected') })
  hub.subscribe('window-1', (event) => received.push(event.sequence))

  assert.doesNotThrow(() => hub.publish({ windowId: 'window-1', sequence: 1, type: 'window.started' }))
  assert.deepEqual(received, [1])
})
