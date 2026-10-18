import type { SpecWorker } from './client'
import type { OpenResult, Source } from './protocol'
import type { ViewerGlobal } from './registry'

/**
 * Hands an opened spec to the app and starts it. The app reads the registry module when it loads, so the
 * global is set first. `shareable` is false for a page that is not the viewer's own (an embed), where a
 * link back to `?spec=` would point at a page that does not read it.
 */
export async function mountOpened(o: {
  result: OpenResult
  worker: SpecWorker
  source: Source
  baseUrl?: string
  defaultEnv?: string
  shareable?: boolean
  setTitle?: boolean
}): Promise<void> {
  const { worker: w } = o
  const g: ViewerGlobal = {
    open: o.result,
    baseUrl: o.baseUrl,
    defaultEnv: o.defaultEnv,
    source:
      o.shareable === false
        ? undefined
        : o.source.kind === 'url'
          ? { kind: 'url', url: o.source.url }
          : { kind: 'text' },
    bundle: (id) => w.bundle(id) as Promise<Record<string, any>>,
    definitions: () => w.definitions() as Promise<Record<string, any>>,
  }
  globalThis.__SPECBOOK_VIEWER__ = g
  if (o.setTitle !== false) document.title = `${o.result.title} · Specbook`
  await import('../main')
  warmFaker()
}

/**
 * Mock responses are generated with the spec, so the first mock request needs no faker. Faker (a
 * sizeable chunk) is only used by "Dynamic" examples and `{{faker.*}}` values, so it is fetched when the
 * page has been idle for a moment instead of up front: by the time someone picks Dynamic it is cached.
 */
function warmFaker() {
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData)
    return
  const idle: (f: () => void) => void =
    (window as unknown as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback ??
    ((f) => setTimeout(f, 1500))
  idle(() => {
    // the registry's loader is the same import the run would make
    void import('./registry').then((r) => r.loadFaker()).catch(() => {})
  })
}
