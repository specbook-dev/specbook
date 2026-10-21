import { createRelay, type Link } from './relay'

// registered for the same page twice (a built-in match and "Enable"): relay once
const flag = '__specbookRelay'
const w = window as unknown as Record<string, unknown>
if (!w[flag]) {
  w[flag] = true
  const relay = createRelay({
    toPage: (m) =>
      window.postMessage(m, window.location.origin === 'null' ? '*' : window.location.origin),
    connect(): Link {
      const port = chrome.runtime.connect({ name: 'specbook' })
      return {
        post: (m) => port.postMessage(m),
        onMessage: (cb) => port.onMessage.addListener(cb),
        onClose: (cb) => port.onDisconnect.addListener(cb),
        close: () => port.disconnect(),
      }
    },
  })
  window.addEventListener('message', (e) => {
    // only this window's own scripts: not a parent frame, not another window
    if (e.source === window) relay(e.data)
  })
}
