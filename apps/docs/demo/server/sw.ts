import { createDemoApp } from './app'
import { idbStore } from './store-idb'

declare const self: ServiceWorkerGlobalScope

// The demo API answers in the visitor's browser: no server, no CORS, and it works offline. It takes only same-origin calls
// under /api; every other request is left alone, so the worker can never serve a stale page.
const app = createDemoApp({ store: idbStore() })

self.addEventListener('install', () => void self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/'))
    event.respondWith(app.fetch(event.request))
})
