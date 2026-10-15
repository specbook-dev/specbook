import workerUrl from './worker.ts?worker&url'

/**
 * The spec worker. A browser will not start a `Worker` from another origin's URL, and the embed script
 * is exactly that when a page loads it from the CDN, so a cross-origin worker is started from a blob
 * that imports it (the module's own CORS headers make that allowed). A host page whose CSP forbids blob
 * workers cannot use this path; it serves the viewer's files itself instead.
 */
export function startWorker(): Worker {
  const url = new URL(workerUrl, import.meta.url)
  if (url.origin === location.origin) return new Worker(url, { type: 'module' })
  const blob = new Blob([`import ${JSON.stringify(url.href)}`], { type: 'text/javascript' })
  return new Worker(URL.createObjectURL(blob), { type: 'module' })
}
