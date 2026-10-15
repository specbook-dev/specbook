/**
 * The registry the UI reads (`virtual:specbook/registry`) for a spec opened at run time. The shell opens
 * the document in a worker and puts the result on `globalThis.__SPECBOOK_VIEWER__` before the app is
 * imported; this module turns that into the same named exports the dev server and the static build give.
 */
import { defineOperation, type OpMeta } from '@specbook/core'
import type { OpenResult } from './protocol'

export interface ViewerGlobal {
  open: OpenResult
  bundle(opId: string): Promise<Record<string, any>>
  definitions(): Promise<Record<string, any>>
  /** the base URL the person gave, when the document has none of its own */
  baseUrl?: string
  /** where the document came from, which decides whether a link to this view can be shared */
  source?: import('./share').ViewerSource
}

declare global {
  // set by the shell
  var __SPECBOOK_VIEWER__: ViewerGlobal | undefined
}

const v = globalThis.__SPECBOOK_VIEWER__
if (!v) throw new Error('The viewer registry was imported before a spec was opened')

const { open } = v
const service = open.service
const keyOf = (id: string) => `${service}/${id}`
const ids = Object.keys(open.metas)

export const mode = 'static' as const
export const project = { root: '', outDir: '', requestsDir: 'requests' }
export const manifests = { [service]: open.manifest }
export const requests: never[] = []
export const sequences: never[] = []
export const sequenceMeta = {}
export const unresolvedSequences: string[] = []
export const brandingAssets = {}
export const environmentVars = {}
export const docs: never[] = []

/** Per operation bundles are fetched from the worker once and kept. */
const bundles = new Map<string, Promise<Record<string, any>>>()
const bundle = (key: string) => {
  const id = key.slice(service.length + 1)
  const have = bundles.get(key)
  if (have) return have
  const fresh: Promise<Record<string, any>> = v.bundle(id).catch(() => ({}))
  bundles.set(key, fresh)
  return fresh
}

/** A lookup that answers only for `service/Operation` keys. */
const byKey = <T>(make: (key: string) => T) =>
  new Proxy({} as Record<string, T>, {
    get: (_, k) =>
      typeof k === 'string' &&
      k.startsWith(`${service}/`) &&
      ids.includes(k.slice(service.length + 1))
        ? make(k)
        : undefined,
    has: (_, k) =>
      typeof k === 'string' &&
      k.startsWith(`${service}/`) &&
      ids.includes(k.slice(service.length + 1)),
    ownKeys: () => ids.map(keyOf),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  })

const part = (pick: (b: Record<string, any>) => unknown) =>
  byKey((key) => () => bundle(key).then((b) => ({ default: pick(b) })))

export const schemas = part((b) => b.schema)
export const responseSchemas = part((b) => b.responses)
export const operationDocs = part((b) => b.docs)

export const definitions = {
  [service]: () => v.definitions().then((d) => ({ default: d })),
}

/** Mock responses are keyed `service/Operation.<status|default>`. */
export const examples = new Proxy({} as Record<string, () => Promise<{ default: unknown }>>, {
  get: (_, k) => {
    if (typeof k !== 'string' || !k.includes('.')) return undefined
    const at = k.lastIndexOf('.')
    const key = k.slice(0, at)
    if (!ids.includes(key.slice(service.length + 1))) return undefined
    return () => bundle(key).then((b) => ({ default: b.mock?.[k.slice(at + 1)] }))
  },
})

export const requestExamples = byKey((key) =>
  (open.exampleNames[key.slice(service.length + 1)] ?? []).map((name) => ({
    name,
    source: 'generated' as const,
    dir: `${key}@generated`,
    load: () => bundle(key).then((b) => ({ default: b.examples?.[name] })),
  })),
)

/** Upload fields are filled with a small sample file, served from memory. */
let sample: string | undefined
export const assets = new Proxy({} as Record<string, () => Promise<string>>, {
  get: (_, k) =>
    typeof k === 'string' && k.endsWith('/sample.txt')
      ? () => {
          sample ??= URL.createObjectURL(
            new Blob(['specbook sample file\n'], { type: 'text/plain' }),
          )
          return Promise.resolve(sample)
        }
      : undefined,
})

export const operations = Object.fromEntries(
  ids.map((id) => [
    keyOf(id),
    async () => ({ [id]: defineOperation(open.metas[id] as unknown as OpMeta) }),
  ]),
) as Record<string, () => Promise<Record<string, any>>>

/**
 * Faker, English only: a locale is its own chunk in a project build, but a viewer opening a stranger's
 * spec has no reason to ship the others. Loaded only when a run uses `{{faker.*}}`.
 */
export const loadFaker = () =>
  import('./faker-en').then((m) => ({
    Faker: m.Faker,
    // a run asks for its locale and `base`, the fallback every locale chain ends in
    locales: {
      en: () => Promise.resolve(m.en),
      base: () => Promise.resolve(m.base),
    },
  }))

// `live` is the document's first server, or the address the person typed for it; the rest keep their own names
const live = v.baseUrl ?? open.baseUrl
const baseUrl: Record<string, string> = {
  ...(live ? { live } : {}),
  ...Object.fromEntries(open.servers.filter((s) => s.name !== 'live').map((s) => [s.name, s.url])),
}
const described = Object.fromEntries(
  open.servers.filter((s) => s.description).map((s) => [s.name, { description: s.description }]),
)
export const loadConfig = () =>
  Promise.resolve({
    default: {
      project: service,
      secrets: open.secrets,
      auth: open.auth,
      ...(Object.keys(described).length ? { environments: described } : {}),
      // one locale, so the header offers no locale choice
      faker: { default: 'en', locales: { en: ['en', 'base'] } },
      services: {
        [service]: {
          spec: '',
          baseUrl,
          ...(open.defaultProfile ? { auth: open.defaultProfile } : {}),
        },
      },
    },
  })
