export function createWindowEventHub() {
  const listenersByWindow = new Map()

  return {
    subscribe(windowId, listener) {
      const listeners = listenersByWindow.get(windowId) || new Set()
      listeners.add(listener)
      listenersByWindow.set(windowId, listeners)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) listenersByWindow.delete(windowId)
      }
    },
    publish(event) {
      const listeners = listenersByWindow.get(event.windowId)
      if (!listeners) return
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch {
          // An SSE response can close between subscription lookup and write.
        }
      }
    },
  }
}
