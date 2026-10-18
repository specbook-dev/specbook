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
    setTitle: o.setTitle,
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
}
