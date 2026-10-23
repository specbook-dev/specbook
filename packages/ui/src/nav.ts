import { signal } from '@preact/signals'

export type PanelTab = 'docs' | 'try'

/**
 * The page is always the catalog; an operation or sequence route opens the side panel on top of it.
 * `play` is the example to open ('' = the first), `tab` picks Docs or Try (default Try).
 */
export type Route =
  | { kind: 'home' }
  /** the catalog itself, without the overview: what a phone shows after its splash screen */
  | { kind: 'browse' }
  | { kind: 'op'; key: string; play?: string; tab?: PanelTab }
  | { kind: 'seq'; id: string; play?: string; tab?: PanelTab }

/**
 * A project with one API needs no service in its links: `#/op/FindPetsByStatus`, not
 * `#/op/swagger-petstore-openapi-3-0/FindPetsByStatus`. The app names that service once it knows the
 * registry; a longer link (an older one, or one from a project with several APIs) still opens.
 */
let defaultService: string | undefined

export function setDefaultService(name: string | undefined) {
  defaultService = name
  if (typeof location !== 'undefined') route.value = parseHash(location.hash)
}

const keyOut = (key: string) =>
  defaultService && key.startsWith(`${defaultService}/`)
    ? key.slice(defaultService.length + 1)
    : key
const keyIn = (key: string) =>
  defaultService && !key.includes('/') ? `${defaultService}/${key}` : key
/** Slashes read fine in a fragment, so only what would be ambiguous is escaped. */
const soft = (s: string) => encodeURIComponent(s).replace(/%2F/gi, '/')

export function parseHash(hash: string): Route {
  const [path = '', query = ''] = hash.split('?')
  const q = new URLSearchParams(query)
  const play = q.get('play') ?? undefined
  const t = q.get('tab')
  const tab = t === 'docs' || t === 'try' ? t : undefined
  const op = /^#\/op\/(.+)$/.exec(path)
  if (op) return { kind: 'op', key: keyIn(decodeURIComponent(op[1] as string)), play, tab }
  const seq = /^#\/seq\/(.+)$/.exec(path)
  if (seq) return { kind: 'seq', id: decodeURIComponent(seq[1] as string), play, tab }
  if (path === '#/browse') return { kind: 'browse' }
  return { kind: 'home' }
}

export function hashFor(r: Route): string {
  if (r.kind === 'home') return '#/'
  if (r.kind === 'browse') return '#/browse'
  const base = r.kind === 'op' ? `#/op/${soft(keyOut(r.key))}` : `#/seq/${encodeURIComponent(r.id)}`
  const q = new URLSearchParams()
  if (r.play !== undefined) q.set('play', r.play)
  if (r.tab) q.set('tab', r.tab)
  const s = q.toString()
  return s ? `${base}?${s}` : base
}

/** A phone's home is its splash screen, so closing a panel lands on the list rather than back on it. */
export const isPhone = () =>
  typeof matchMedia === 'function' && matchMedia('(max-width: 820px)').matches
export const pageOf = (_r: Route): Route => (isPhone() ? { kind: 'browse' } : { kind: 'home' })

export const route = signal<Route>(parseHash(typeof location === 'undefined' ? '' : location.hash))
export const paletteOpen = signal(false)
/** The catalog's service pill ('' = overview) and filter text. */
export const catalogService = signal('')
export const catalogFilter = signal('')

let navigator: ((r: Route) => void) | undefined

/** A host that is not the app (an embed) takes links itself instead of writing the page's address. */
export const setNavigator = (fn: ((r: Route) => void) | undefined) => {
  navigator = fn
}

export function go(r: Route) {
  if (navigator) return navigator(r)
  location.hash = hashFor(r)
  route.value = r
}

export interface Entry {
  route: Route
  title: string
  /** group label shown muted, e.g. "pet" */
  group: string
  service?: string
  tag?: string
  /** operations */
  method?: string
  path?: string
  /** the spec requires credentials */
  secured?: boolean
  /** what the lock says when hovered: which schemes, with which scopes */
  lockTitle?: string
  /** sequences */
  /** flows and requests */
  tags?: string[]
  /** the flow group heading */
  flowGroup?: string
  description?: string
  /** extra text matched by search, never shown */
  hay: string
  /** `req`: a saved request, which opens its operation on that request */
  kind: 'seq' | 'op' | 'req'
}

export function search(entries: Entry[], query: string, limit = 40): Entry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return entries.slice(0, limit)
  const scored: [number, Entry][] = []
  for (const e of entries) {
    const title = e.title.toLowerCase()
    const hay = `${title} ${e.group.toLowerCase()} ${e.hay.toLowerCase()}`
    if (!terms.every((t) => hay.includes(t))) continue
    // prefer title matches and sequences
    let score = 0
    for (const t of terms) score += title.startsWith(t) ? 3 : title.includes(t) ? 2 : 1
    if (e.kind === 'seq') score += 0.5
    if (e.kind === 'req') score += 0.4
    scored.push([score, e])
  }
  return scored
    .sort((a, b) => b[0] - a[0])
    .slice(0, limit)
    .map(([, e]) => e)
}
