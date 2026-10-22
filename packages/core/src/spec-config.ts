/**
 * Facts about an API that come from its document alone: how it authenticates and where it lives. Shared by
 * the CLI's `preview` and the browser viewer, so both read a spec the same way.
 */

import type { OAuthSettings } from './oauth'

const isUrl = (s: string) => /^https?:\/\//i.test(s)

export interface JsonAuthProfile {
  title: string
  apply: { headers?: Record<string, string>; query?: Record<string, string> }
  /** present when the scheme has an authorization code flow the UI can sign in to */
  oauth?: OAuthSettings
}

/** Gives the address a profile field should carry for a raw URL from the document. */
type Address = (field: 'authorizationUrl' | 'tokenUrl' | 'openIdConnectUrl', raw: string) => string

/** An OpenID Connect scheme: the discovery document says where to sign in. */
function discovery(s: any, address: Address): OAuthSettings | undefined {
  if (typeof s.openIdConnectUrl !== 'string' || s.openIdConnectUrl === '') return undefined
  try {
    return { openIdConnectUrl: address('openIdConnectUrl', s.openIdConnectUrl) }
  } catch {
    return undefined
  }
}

/** The authorization code flow of an OAuth scheme (OpenAPI 3 `flows`, or Swagger 2 `accessCode`). */
function codeFlow(s: any, address: Address): OAuthSettings | undefined {
  const flow = s.flows?.authorizationCode ?? (s.flow === 'accessCode' ? s : undefined)
  if (!flow?.authorizationUrl || !flow?.tokenUrl) return undefined
  const abs = (field: 'authorizationUrl' | 'tokenUrl', u: string) => {
    try {
      return address(field, u)
    } catch {
      return u
    }
  }
  return {
    authorizationUrl: abs('authorizationUrl', flow.authorizationUrl),
    tokenUrl: abs('tokenUrl', flow.tokenUrl),
    ...(flow.scopes && Object.keys(flow.scopes).length ? { scopes: flow.scopes } : {}),
  }
}

export interface SpecAuth {
  auth: Record<string, JsonAuthProfile>
  /** secret name -> {} (values come from the UI or the environment) */
  secrets: Record<string, Record<string, never>>
  /** the profile requests use unless they say otherwise */
  defaultProfile?: string
  /**
   * Sign-in addresses the document gives relative to its servers become variables, so each environment
   * signs in at its own server: the `live` values here, and one entry per other environment below.
   */
  vars: Record<string, string>
  environmentVars: Record<string, Record<string, string>>
}

const secretName = (scheme: string) =>
  scheme
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || 'API_KEY'

export type SchemeKind = 'apiKey' | 'bearer' | 'basic' | 'oauth'

export interface SchemeCredential {
  kind: SchemeKind
  title: string
  apply: JsonAuthProfile['apply']
}

/**
 * What one security scheme sends, with `ref` (a `{{secrets.NAME}}` placeholder) standing for the value. Undefined for a
 * scheme that cannot be expressed as a header or query value (mutualTLS, an unknown type or location).
 */
export function schemeCredential(name: string, s: any, ref: string): SchemeCredential | undefined {
  if (s?.type === 'apiKey') {
    const key = s.name as string
    const title = `${name} (API key, ${s.in} "${key}")`
    if (s.in === 'header') return { kind: 'apiKey', title, apply: { headers: { [key]: ref } } }
    if (s.in === 'query') return { kind: 'apiKey', title, apply: { query: { [key]: ref } } }
    if (s.in === 'cookie')
      return { kind: 'apiKey', title, apply: { headers: { cookie: `${key}=${ref}` } } }
    return undefined
  }
  if (s?.type === 'http' && /^bearer$/i.test(s.scheme))
    return {
      kind: 'bearer',
      title: `${name} (bearer token)`,
      apply: { headers: { authorization: `Bearer ${ref}` } },
    }
  // the template language has no base64, so the user pastes the encoded `user:password`
  if ((s?.type === 'http' && /^basic$/i.test(s.scheme)) || s?.type === 'basic')
    return {
      kind: 'basic',
      title: `${name} (basic auth, paste base64 of user:password)`,
      apply: { headers: { authorization: `Basic ${ref}` } },
    }
  if (s?.type === 'oauth2' || s?.type === 'openIdConnect')
    return {
      kind: 'oauth',
      title: `${name} (OAuth, paste an access token)`,
      apply: { headers: { authorization: `Bearer ${ref}` } },
    }
  return undefined
}

/**
 * Turns a document's security schemes into auth profiles whose secrets are filled in at run time, so
 * previewing a protected API only needs the user to paste a key. OAuth-style schemes take an access token.
 */
export function authFromSpec(api: any, source?: string, servers?: ServerEntry[]): SpecAuth {
  const schemes: Record<string, any> =
    api.components?.securitySchemes ?? api.securityDefinitions ?? {}
  const out: SpecAuth = { auth: {}, secrets: {}, vars: {}, environmentVars: {} }
  const pageBase = source && isUrl(source) ? source : undefined
  const resolve = (raw: string, base: string | undefined) => new URL(raw, base).toString()
  // a relative address follows the server (OpenAPI 3.1): one variable per scheme and field, set per environment
  const addressFor =
    (scheme: string): Address =>
    (field, raw) => {
      if (!servers?.length || isUrl(raw)) return resolve(raw, pageBase)
      const name = `${secretName(scheme)
        .toLowerCase()
        .replace(/_(.)/g, (_, c) => c.toUpperCase())}${field[0]?.toUpperCase()}${field.slice(1)}`
      let any = false
      for (const sv of servers) {
        try {
          const abs = resolve(raw, sv.url.endsWith('/') ? sv.url : `${sv.url}/`)
          if (sv.name === 'live') out.vars[name] = abs
          else out.environmentVars[sv.name] = { ...out.environmentVars[sv.name], [name]: abs }
          any = true
        } catch {
          /* this server cannot resolve it */
        }
      }
      if (!any) return resolve(raw, pageBase)
      if (out.vars[name] === undefined) {
        try {
          out.vars[name] = resolve(raw, pageBase)
        } catch {
          out.vars[name] = raw
        }
      }
      return `{{${name}}}`
    }
  for (const [name, s] of Object.entries(schemes)) {
    const secret = secretName(name)
    const cred = schemeCredential(name, s, `{{secrets.${secret}}}`)
    if (!cred) continue
    let { title } = cred
    let oauth: OAuthSettings | undefined
    if (cred.kind === 'oauth') {
      const address = addressFor(name)
      oauth = s.type === 'oauth2' ? codeFlow(s, address) : discovery(s, address)
      title = `${name} (OAuth, ${oauth ? 'sign in or ' : ''}paste an access token)`
    }
    out.auth[name] = { title, apply: cred.apply, ...(oauth ? { oauth } : {}) }
    out.secrets[secret] = {}
  }
  // the document's top-level `security` says which scheme most operations use
  const top = (api.security as Record<string, unknown>[] | undefined)?.flatMap((r) =>
    Object.keys(r),
  )
  out.defaultProfile = top?.find((n) => out.auth[n]) ?? Object.keys(out.auth)[0]
  return out
}

// ---- the credentials one service needs, for `specbook add` to write into a project's config

/** Upper-case words of a name: `clientId` is CLIENT, ID; `x-api-key` is X, API, KEY. */
const nameWords = (s: string): string[] =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase())

/**
 * The secret a scheme's value is kept in, named after the service so two services never share one:
 * `plaid` + `clientId` is PLAID_CLIENT_ID, `petstore` + `api_key` is PETSTORE_API_KEY, and a scheme that already starts
 * with the service's name is not prefixed twice (`plaid` + `plaidVersion` is PLAID_VERSION).
 */
export function serviceSecretName(service: string, scheme: string): string {
  const p = nameWords(service)
  const own = nameWords(scheme)
  const s = own.length ? own : ['API', 'KEY']
  const startsWithService = s.length >= p.length && p.every((w, i) => w === s[i])
  if (startsWithService) return (s.length === p.length ? [...s, 'KEY'] : s).join('_')
  return [...p, ...s].join('_')
}

export interface SpecCredentials {
  /** one profile named after the service, with every scheme of the way chosen to authenticate */
  profile?: {
    name: string
    title: string
    apply: JsonAuthProfile['apply']
    /** the schemes it applies, in the order the spec lists them */
    schemes: string[]
  }
  /** the secrets its `apply` reads, in the order they are used */
  secrets: string[]
  /** one line each, at most three: what is left for a person to finish or decide */
  notes: string[]
}

const COST: Record<SchemeKind, number> = { apiKey: 0, bearer: 0, basic: 1, oauth: 2 }
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

/** The thing a local reference (`#/components/securitySchemes/x`) points at. */
function pointer(api: any, ref: string): any {
  let at = api
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
    at = at?.[key]
    if (at === undefined) return undefined
  }
  return at
}

/** Headers and query values of several schemes in one: a header named twice is a clash, except cookies, which join. */
function mergeApply(parts: JsonAuthProfile['apply'][]): JsonAuthProfile['apply'] | undefined {
  const headers = new Map<string, [string, string]>()
  const query: Record<string, string> = {}
  for (const part of parts) {
    for (const [k, v] of Object.entries(part.headers ?? {})) {
      const low = k.toLowerCase()
      const had = headers.get(low)
      if (!had) headers.set(low, [k, v])
      else if (low === 'cookie') headers.set(low, [had[0], `${had[1]}; ${v}`])
      else return undefined
    }
    for (const [k, v] of Object.entries(part.query ?? {})) {
      if (k in query) return undefined
      query[k] = v
    }
  }
  return {
    ...(headers.size ? { headers: Object.fromEntries(headers.values()) } : {}),
    ...(Object.keys(query).length ? { query } : {}),
  }
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0')

const kindLabel = (kind: SchemeKind, count: number) =>
  kind === 'apiKey'
    ? count > 1
      ? 'API keys'
      : 'API key'
    : kind === 'bearer'
      ? 'bearer token'
      : kind === 'basic'
        ? 'basic auth'
        : 'OAuth token'

/**
 * How a service's calls authenticate, as one profile a project can use: the cheapest way the spec accepts that a pasted
 * value can fill (an API key or bearer token before basic auth before OAuth). Schemes a requirement lists together must
 * all apply, so they share a profile. Everything the spec accepts that is not written is said in `notes`.
 */
export function credentialsFromSpec(api: any, service: string): SpecCredentials {
  const raw: Record<string, any> = api.components?.securitySchemes ?? api.securityDefinitions ?? {}
  if (!Object.keys(raw).length) return { secrets: [], notes: [] }
  const schemes: Record<string, any> = {}
  const elsewhere: string[] = []
  for (const [name, v] of Object.entries(raw)) {
    if (typeof v?.$ref !== 'string') schemes[name] = v
    else {
      const target = v.$ref.startsWith('#/') ? pointer(api, v.$ref) : undefined
      if (target) schemes[name] = target
      else elsewhere.push(name)
    }
  }

  // what each operation accepts: its own `security`, else the document's; every entry lists schemes that apply together
  const ops: string[][][] = []
  for (const item of Object.values<any>(api.paths ?? {}))
    for (const method of METHODS) {
      const op = item?.[method]
      if (!op || typeof op !== 'object') continue
      const sec = op.security ?? api.security
      if (!Array.isArray(sec)) continue
      const reqs = sec.map((r: any) => Object.keys(r ?? {})).filter((k: string[]) => k.length)
      if (reqs.length) ops.push(reqs)
    }

  type Way = { names: string[]; uses: number }
  let ways: Way[] = []
  const top: string[][] = Array.isArray(api.security)
    ? api.security.map((r: any) => Object.keys(r ?? {})).filter((k: string[]) => k.length)
    : []
  if (top.length) ways = top.map((names) => ({ names, uses: 0 }))
  else
    for (const reqs of ops)
      for (const names of reqs) {
        const have = ways.find((w) => sameSet(w.names, names))
        if (have) have.uses++
        else ways.push({ names, uses: 1 })
      }
  // schemes that nothing uses secure nothing: there is nothing to write
  if (!ways.length) return { secrets: [], notes: [] }

  // a way is usable when every scheme it lists can be written and the headers do not clash
  const usable: (Way & { index: number; cost: number })[] = []
  const unwritable = new Set<string>()
  const clashes: string[][] = []
  const unreadable = [
    ...new Set([...elsewhere, ...ways.flatMap((w) => w.names).filter((n) => !(n in raw))]),
  ]
  for (const [index, way] of ways.entries()) {
    const creds = way.names.map((n) =>
      schemes[n] ? schemeCredential(n, schemes[n], 'x') : undefined,
    )
    way.names.forEach((n, i) => {
      if (!creds[i] && schemes[n]) unwritable.add(n)
    })
    if (creds.some((c) => !c)) continue
    const parts = creds.map((c) => (c as SchemeCredential).apply)
    if (!mergeApply(parts)) {
      clashes.push(way.names)
      continue
    }
    usable.push({
      ...way,
      index,
      cost: Math.max(...creds.map((c) => COST[(c as SchemeCredential).kind])),
    })
  }
  const notes: string[] = []
  const unreadableNote = () =>
    `${unreadable.join(', ')} ${unreadable.length === 1 ? 'is' : 'are'} not defined in the document itself (a reference to another file is not followed)`
  if (!usable.length) {
    if (unreadable.length) notes.push(unreadableNote())
    if (unwritable.size)
      notes.push(`${[...unwritable].join(', ')} cannot be sent as a header or a query value`)
    for (const names of clashes)
      notes.push(`${names.join(' and ')} would set the same header, so they are not written`)
    return { secrets: [], notes: notes.slice(0, 3) }
  }
  const chosen = [...usable].sort(
    (a, b) => a.cost - b.cost || b.uses - a.uses || a.index - b.index,
  )[0] as (typeof usable)[number]

  // the secrets, one per scheme, and the profile with the real placeholders
  const taken = new Set<string>()
  const secretOf: Record<string, string> = {}
  for (const n of chosen.names) {
    let name = serviceSecretName(service, n)
    for (let i = 2; taken.has(name); i++) name = `${serviceSecretName(service, n)}_${i}`
    taken.add(name)
    secretOf[n] = name
  }
  const creds = chosen.names.map((n) => ({
    name: n,
    scheme: schemes[n],
    cred: schemeCredential(n, schemes[n], `{{secrets.${secretOf[n]}}}`) as SchemeCredential,
  }))
  const apply = mergeApply(creds.map((c) => c.cred.apply)) as JsonAuthProfile['apply']
  const kinds = [...new Set(creds.map((c) => c.cred.kind))]
  const title = kinds.length === 1 ? kindLabel(kinds[0] as SchemeKind, creds.length) : 'credentials'

  if (unreadable.length) notes.push(unreadableNote())
  for (const { name, scheme } of creds)
    if (scheme.type === 'apiKey' && /version/i.test(String(scheme.name)))
      notes.push(
        `${scheme.name} reads like a version, not a credential: put its value in ${secretOf[name]}`,
      )
  for (const { name, cred } of creds) {
    if (cred.kind === 'basic') notes.push(`${secretOf[name]} is the base64 of user:password`)
    if (cred.kind === 'oauth')
      notes.push(
        `${secretOf[name]} takes an access token: sign-in settings are not written (paste a token, or add an oauth block)`,
      )
  }
  // secured operations that do not accept this way, and what else the spec offers
  const missed = ops.filter((reqs) => !reqs.some((names) => sameSet(names, chosen.names)))
  if (missed.length) {
    const only = [...new Set(missed.flat(2))].filter((n) => !chosen.names.includes(n))
    notes.push(
      `${missed.length} operation${missed.length === 1 ? '' : 's'} take${missed.length === 1 ? 's' : ''} only ${only.join(', ')}, which ${only.length === 1 ? 'is' : 'are'} not set up`,
    )
  } else {
    const also = [...new Set([...ways.flatMap((w) => w.names), ...ops.flat(2)])].filter(
      (n) => !chosen.names.includes(n) && schemes[n],
    )
    if (also.length) notes.push(`also accepted: ${also.join(', ')} (not set up)`)
  }
  return {
    profile: { name: service, title, apply, schemes: chosen.names },
    secrets: chosen.names.map((n) => secretOf[n] as string),
    notes: notes.slice(0, 3),
  }
}

/** One server a spec lists, as an environment the UI can switch to. */
export interface ServerEntry {
  /** the environment name: `live` for the first, else a slug of its description or host */
  name: string
  url: string
  description?: string
}

/** `live` plus this many minus one: a spec with a server per region should not bury the picker. */
export const MAX_SERVERS = 20

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '')

/** An absolute address for one `servers` entry: variables at their defaults, a relative URL against `source`. */
function resolveServer(entry: any, source: string | undefined): string | undefined {
  if (typeof entry?.url !== 'string') return undefined
  const url = entry.url
    .replace(/\{([^}]+)\}/g, (whole: string, key: string) => {
      const d = entry.variables?.[key]?.default
      return d === undefined || d === null ? whole : String(d)
    })
    .trim()
  if (/\{[^}]*\}/.test(url)) return undefined
  if (isUrl(url)) return url.replace(/\/+$/, '')
  if (source) {
    try {
      return new URL(url, source).toString().replace(/\/+$/, '')
    } catch {
      /* not an address */
    }
  }
  return undefined
}

/**
 * The servers a document lists, as environments. The first is `live` (what a single-server spec has always
 * had); the rest are named from their description, else their host, and are always a valid environment name.
 *
 * `needsBaseUrl` is true when the first server is relative and `source` cannot resolve it: the person is
 * asked for the address, and what they type is `live`. `omitted` counts usable servers beyond `MAX_SERVERS`.
 */
export function openApiServers(
  api: any,
  source: string,
): { servers: ServerEntry[]; needsBaseUrl: boolean; omitted: number } {
  const src = isUrl(source) ? source : undefined
  const listed: any[] = Array.isArray(api.servers) ? api.servers : []
  const servers: ServerEntry[] = []
  const describe = (e: any) =>
    typeof e?.description === 'string' && e.description.trim() !== ''
      ? { description: e.description.trim() as string }
      : {}

  if (listed.length === 0) {
    // Swagger 2, or an OpenAPI 3 document that says nothing: the host, else wherever it was fetched from
    if (api.host)
      servers.push({
        name: 'live',
        url: `${api.schemes?.[0] ?? 'https'}://${api.host}${api.basePath ?? ''}`.replace(
          /\/+$/,
          '',
        ),
      })
    else if (src) servers.push({ name: 'live', url: new URL(src).origin })
    return { servers, needsBaseUrl: false, omitted: 0 }
  }

  const first = resolveServer(listed[0], src)
  if (first) servers.push({ name: 'live', url: first, ...describe(listed[0]) })
  const needsBaseUrl =
    !first && typeof listed[0]?.url === 'string' && !/^https?:\/\//i.test(listed[0].url)

  const taken = new Set(['mock', 'live'])
  const seen = new Set(servers.map((x) => x.url))
  let omitted = 0
  for (const entry of listed.slice(1)) {
    const url = resolveServer(entry, src)
    if (!url || seen.has(url)) continue
    if (servers.length >= MAX_SERVERS) {
      omitted++
      continue
    }
    seen.add(url)
    const host = (() => {
      try {
        return new URL(url).host
      } catch {
        return ''
      }
    })()
    const base = slug(describe(entry).description ?? '') || slug(host) || 'server'
    let name = base
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
    taken.add(name)
    servers.push({ name, url, ...describe(entry) })
  }
  return { servers, needsBaseUrl, omitted }
}

/**
 * What a document's servers become in a config: the first server's address as the variable `varName`, the
 * others as the same variable in an environment of their own, and a `baseUrl` that reads it.
 */
export function environmentsFromServers(
  servers: ServerEntry[],
  varName: string,
): {
  vars: Record<string, string>
  environments: Record<string, { description?: string; vars?: Record<string, string> }>
  baseUrl: string
} {
  const vars: Record<string, string> = {}
  const environments: Record<string, { description?: string; vars?: Record<string, string> }> = {}
  for (const s of servers) {
    const description = s.description ? { description: s.description } : {}
    if (s.name === 'live') {
      vars[varName] = s.url
      if (s.description) environments.live = description
    } else {
      environments[s.name] = { ...description, vars: { [varName]: s.url } }
    }
  }
  return { vars, environments, baseUrl: `{{${varName}}}` }
}

/** Where the API lives, from `servers[0]` (OpenAPI 3) or `host`/`basePath` (Swagger 2). */
export function liveBaseUrl(api: any, source: string): string | undefined {
  return openApiServers(api, source).servers.find((s) => s.name === 'live')?.url
}
