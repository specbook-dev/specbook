/**
 * Facts about an API that come from its document alone: how it authenticates and where it lives. Shared by
 * the CLI's `preview` and the browser viewer, so both read a spec the same way.
 */

import type { OAuthSettings } from './oauth'

const isUrl = (s: string) => /^https?:\/\//i.test(s)

export interface JsonAuthProfile {
  title: string
  /** the spec scheme(s) this profile satisfies; several apply together */
  scheme?: string | string[]
  apply: { headers?: Record<string, string>; query?: Record<string, string> }
  /** a sign-in the UI can offer (code, implicit, OpenID Connect), or a client credentials grant the runner performs */
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

const scopesOf = (flow: any) =>
  flow?.scopes && Object.keys(flow.scopes).length ? { scopes: flow.scopes } : {}

const absolute = (address: Address) => (field: 'authorizationUrl' | 'tokenUrl', u: string) => {
  try {
    return address(field, u)
  } catch {
    return u
  }
}

/** The authorization code flow of an OAuth scheme (OpenAPI 3 `flows`, or Swagger 2 `accessCode`). */
function codeFlow(s: any, address: Address): OAuthSettings | undefined {
  const flow = s.flows?.authorizationCode ?? (s.flow === 'accessCode' ? s : undefined)
  if (!flow?.authorizationUrl || !flow?.tokenUrl) return undefined
  const abs = absolute(address)
  return {
    authorizationUrl: abs('authorizationUrl', flow.authorizationUrl),
    tokenUrl: abs('tokenUrl', flow.tokenUrl),
    ...scopesOf(flow),
  }
}

/** The implicit flow (OpenAPI 3 `flows.implicit`, or Swagger 2 `implicit`): the token comes back in the address. */
function implicitFlow(s: any, address: Address): OAuthSettings | undefined {
  const flow = s.flows?.implicit ?? (s.flow === 'implicit' ? s : undefined)
  if (!flow?.authorizationUrl) return undefined
  return {
    flow: 'implicit',
    authorizationUrl: absolute(address)('authorizationUrl', flow.authorizationUrl),
    ...scopesOf(flow),
  }
}

/** The client credentials flow (OpenAPI 3 `flows.clientCredentials`, or Swagger 2 `application`). */
function clientFlow(s: any): { tokenUrl: string } | undefined {
  if (s?.type !== 'oauth2') return undefined
  const flow = s.flows?.clientCredentials ?? (s.flow === 'application' ? s : undefined)
  if (typeof flow?.tokenUrl !== 'string' || flow.tokenUrl === '') return undefined
  return { tokenUrl: flow.tokenUrl }
}

/** What a person can sign in to for this scheme, if anything. */
function signInFor(s: any, address: Address): OAuthSettings | undefined {
  if (s?.type === 'openIdConnect') return discovery(s, address)
  if (s?.type !== 'oauth2') return undefined
  return codeFlow(s, address) ?? implicitFlow(s, address)
}

export interface SpecAuth {
  auth: Record<string, JsonAuthProfile>
  /** secret name -> {} (values come from the UI or the environment) */
  secrets: Record<string, Record<string, never>>
  /** the profile requests use unless they say otherwise: the first of `profiles` */
  defaultProfile?: string
  /** every profile, the default first and the cheapest to fill before the dearer */
  profiles: string[]
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

/**
 * The name of a profile for one or more schemes of a service, beside the service's own: `petstore` + `petstore_auth` is
 * `petstore-auth`, `stripe` + `basicAuth` is `stripe-basic-auth`. A scheme that starts with the service's name is not prefixed twice.
 */
export function profileNameFor(service: string, schemes: string[]): string {
  const p = nameWords(service)
  const words = schemes.flatMap((n) => {
    const own = nameWords(n)
    const starts = own.length >= p.length && p.every((w, i) => w === own[i])
    const rest = starts ? own.slice(p.length) : own
    return rest.length ? rest : starts ? ['KEY'] : ['API', 'KEY']
  })
  return [...p, ...words].map((w) => w.toLowerCase()).join('-')
}

export type ProfileKind = SchemeKind | 'clientCredentials'

/** One way to authenticate against a spec, as a profile a config can hold. */
export interface SpecProfile {
  name: string
  title: string
  apply: JsonAuthProfile['apply']
  /** the spec scheme(s) it satisfies, in the order the spec lists them */
  schemes: string[]
  /** the secrets it reads, in the order they are used */
  secrets: string[]
  kind: ProfileKind
  /** what a pasted value costs: an API key or bearer token 0, basic 1, OAuth 2, a server-side grant 3 */
  cost: number
  /** how many operations accept this way */
  uses: number
  /** a sign-in a person can use, or the client credentials the runner performs */
  oauth?: OAuthSettings
  /** its secrets are only ever filled by a server (the CLI, a bundle, the dev proxy), never typed into a page */
  serverSide?: boolean
}

export interface SpecProfiles {
  /** the default first */
  profiles: SpecProfile[]
  /** every secret the profiles read, once, in order */
  secrets: string[]
  /** one line each: what is left for a person to finish or decide */
  notes: string[]
  /** sign-in addresses relative to the document's servers, as variables (see `SpecAuth`) */
  vars: Record<string, string>
  environmentVars: Record<string, Record<string, string>>
}

const COST: Record<ProfileKind, number> = {
  apiKey: 0,
  bearer: 0,
  basic: 1,
  oauth: 2,
  clientCredentials: 3,
}
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

const kindLabel = (kind: ProfileKind, count: number, signIn: boolean) =>
  kind === 'apiKey'
    ? count > 1
      ? 'API keys'
      : 'API key'
    : kind === 'bearer'
      ? 'bearer token'
      : kind === 'basic'
        ? 'basic auth'
        : kind === 'clientCredentials'
          ? 'OAuth client credentials'
          : signIn
            ? 'OAuth sign-in'
            : 'OAuth token'

const camel = (secret: string) => secret.toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase())

export interface ProfilesOptions {
  /** `scheme`: a profile per scheme, named for it (the viewer). `service`: the first is named for the service (`add`). */
  naming: 'scheme' | 'service'
  service?: string
  /** where the document was fetched from, to resolve a relative sign-in address */
  source?: string
  servers?: ServerEntry[]
  /** also list schemes no operation requires, last */
  includeUnreferenced?: boolean
  /** also give an OAuth scheme with a client credentials flow a profile the runner signs in with */
  clientCredentials?: boolean
}

/**
 * Every way a spec accepts to authenticate, as profiles, the cheapest to fill first. The ways are the requirement sets of
 * the document's `security` and of each operation (schemes a requirement lists together must all apply, so they share a
 * profile). A way that cannot be sent as a header or a query value, or whose schemes would set the same header, is left
 * out and said in `notes`.
 */
export function profilesFromSpec(api: any, o: ProfilesOptions): SpecProfiles {
  const none: SpecProfiles = { profiles: [], secrets: [], notes: [], vars: {}, environmentVars: {} }
  const raw: Record<string, any> = api.components?.securitySchemes ?? api.securityDefinitions ?? {}
  if (!Object.keys(raw).length) return none
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
  const requirements = (sec: unknown): string[][] =>
    Array.isArray(sec)
      ? sec.map((r: any) => Object.keys(r ?? {})).filter((k: string[]) => k.length)
      : []
  const ops: string[][][] = []
  for (const item of Object.values<any>(api.paths ?? {}))
    for (const method of METHODS) {
      const op = item?.[method]
      if (!op || typeof op !== 'object') continue
      const reqs = requirements(op.security ?? api.security)
      if (reqs.length) ops.push(reqs)
    }

  type Way = { names: string[]; uses: number; index: number; referenced: boolean }
  const ways: Way[] = []
  for (const names of requirements(api.security))
    if (!ways.some((w) => sameSet(w.names, names)))
      ways.push({ names, uses: 0, index: ways.length, referenced: true })
  for (const reqs of ops)
    for (const names of reqs) {
      const have = ways.find((w) => sameSet(w.names, names))
      if (have) have.uses++
      else ways.push({ names, uses: 1, index: ways.length, referenced: true })
    }
  const referenced = ways.length
  if (o.includeUnreferenced)
    for (const name of Object.keys(raw))
      if (!ways.some((w) => w.names.includes(name)))
        ways.push({ names: [name], uses: 0, index: ways.length, referenced: false })
  // schemes that nothing uses secure nothing: there is nothing to write
  if (!ways.length) return none

  // a way is usable when every scheme it lists can be written and the headers do not clash
  const usable: Way[] = []
  const unwritable = new Set<string>()
  const clashes: string[][] = []
  const unreadable = [
    ...new Set([
      ...elsewhere,
      ...ways
        .slice(0, referenced)
        .flatMap((w) => w.names)
        .filter((n) => !(n in raw)),
    ]),
  ]
  for (const [i, way] of ways.entries()) {
    const creds = way.names.map((n) =>
      schemes[n] ? schemeCredential(n, schemes[n], 'x') : undefined,
    )
    if (i < referenced)
      way.names.forEach((n, k) => {
        if (!creds[k] && schemes[n]) unwritable.add(n)
      })
    if (creds.some((c) => !c)) continue
    if (!mergeApply(creds.map((c) => (c as SchemeCredential).apply))) {
      if (i < referenced) clashes.push(way.names)
      continue
    }
    usable.push(way)
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
    return { ...none, notes: notes.slice(0, 4) }
  }

  const costOf = (w: Way) =>
    Math.max(
      ...w.names.map((n) => COST[(schemeCredential(n, schemes[n], 'x') as SchemeCredential).kind]),
    )
  // referenced ways by cost, then how many operations take them, then the spec's order; schemes nothing requires last
  const ordered = [
    ...usable
      .filter((w) => w.referenced)
      .sort((a, b) => costOf(a) - costOf(b) || b.uses - a.uses || a.index - b.index),
    ...usable.filter((w) => !w.referenced),
  ]

  const vars: Record<string, string> = {}
  const environmentVars: Record<string, Record<string, string>> = {}
  const service = o.service ?? ''
  const pageBase = o.source && isUrl(o.source) ? o.source : undefined
  const resolve = (rawUrl: string, base: string | undefined) => new URL(rawUrl, base).toString()
  const taken = new Set<string>()
  const secretOf: Record<string, string> = {}
  const secretFor = (scheme: string) => {
    if (secretOf[scheme]) return secretOf[scheme]
    const base = o.naming === 'service' ? serviceSecretName(service, scheme) : secretName(scheme)
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base}_${i}`
    taken.add(name)
    secretOf[scheme] = name
    return name
  }
  // a relative address follows the server (OpenAPI 3.1): one variable per scheme and field, set per environment
  const addressFor =
    (scheme: string): Address =>
    (field, rawUrl) => {
      if (!o.servers?.length || isUrl(rawUrl)) return resolve(rawUrl, pageBase)
      const name = `${camel(secretFor(scheme))}${field[0]?.toUpperCase()}${field.slice(1)}`
      let any = false
      for (const sv of o.servers) {
        try {
          const abs = resolve(rawUrl, sv.url.endsWith('/') ? sv.url : `${sv.url}/`)
          if (sv.name === 'live') vars[name] = abs
          else environmentVars[sv.name] = { ...environmentVars[sv.name], [name]: abs }
          any = true
        } catch {
          /* this server cannot resolve it */
        }
      }
      if (!any) return resolve(rawUrl, pageBase)
      if (vars[name] === undefined) {
        try {
          vars[name] = resolve(rawUrl, pageBase)
        } catch {
          vars[name] = rawUrl
        }
      }
      return `{{${name}}}`
    }

  const used = new Set<string>()
  const unique = (base: string) => {
    let name = base
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`
    used.add(name)
    return name
  }
  const base: SpecProfile[] = []
  const clients: SpecProfile[] = []
  const unreferenced: SpecProfile[] = []
  for (const way of ordered) {
    const creds = way.names.map(
      (n) => schemeCredential(n, schemes[n], `{{secrets.${secretFor(n)}}}`) as SchemeCredential,
    )
    const apply = mergeApply(creds.map((c) => c.apply)) as JsonAuthProfile['apply']
    const single = way.names.length === 1
    const first = way.names[0] as string
    const oauth =
      single && creds[0]?.kind === 'oauth'
        ? signInFor(schemes[first], addressFor(first))
        : undefined
    const kinds = [...new Set(creds.map((c) => c.kind))]
    const kind =
      kinds.length === 1
        ? (kinds[0] as ProfileKind)
        : (kinds.sort((a, b) => COST[b] - COST[a])[0] as ProfileKind)
    const name = unique(
      o.naming === 'scheme'
        ? way.names.join('-')
        : base.length === 0 && way.referenced
          ? service
          : profileNameFor(service, way.names),
    )
    const title =
      o.naming === 'scheme'
        ? single && kind === 'oauth'
          ? `${first} (OAuth, ${oauth ? 'sign in or ' : ''}paste an access token)`
          : single
            ? (creds[0] as SchemeCredential).title
            : `${way.names.join(' + ')} (${kindLabel(kind, creds.length, false)})`
        : kinds.length === 1
          ? kindLabel(kind, creds.length, !!oauth)
          : 'credentials'
    const profile: SpecProfile = {
      name,
      title,
      apply,
      schemes: way.names,
      secrets: way.names.map(secretFor),
      kind,
      cost: costOf(way),
      uses: way.uses,
      ...(oauth ? { oauth } : {}),
    }
    ;(way.referenced ? base : unreferenced).push(profile)

    const flow = single && o.clientCredentials ? clientFlow(schemes[first]) : undefined
    if (flow) {
      const s = secretFor(first)
      const abs = absolute(addressFor(first))
      ;(way.referenced ? clients : unreferenced).push({
        name: unique(`${name}-client`),
        title: kindLabel('clientCredentials', 1, false),
        apply: { headers: { authorization: 'Bearer {{session.accessToken}}' } },
        schemes: way.names,
        secrets: [`${s}_CLIENT_ID`, `${s}_CLIENT_SECRET`],
        kind: 'clientCredentials',
        cost: COST.clientCredentials,
        uses: way.uses,
        serverSide: true,
        oauth: {
          tokenUrl: abs('tokenUrl', flow.tokenUrl),
          clientId: `{{secrets.${s}_CLIENT_ID}}`,
          clientSecret: `{{secrets.${s}_CLIENT_SECRET}}`,
        },
      })
    }
  }
  const profiles = [...base, ...clients, ...unreferenced]
  if (o.naming === 'service') {
    // two profiles that would read the same in a picker say which scheme each is
    const seen = new Map<string, number>()
    for (const p of profiles) seen.set(p.title, (seen.get(p.title) ?? 0) + 1)
    for (const p of profiles)
      if ((seen.get(p.title) ?? 0) > 1) p.title = `${p.title} (${p.schemes.join(', ')})`
  }

  if (unreadable.length) notes.push(unreadableNote())
  for (const p of profiles) {
    if (p.kind === 'clientCredentials') continue
    for (const n of p.schemes) {
      const scheme = schemes[n]
      if (scheme.type === 'apiKey' && /version/i.test(String(scheme.name)))
        notes.push(
          `${scheme.name} reads like a version, not a credential: put its value in ${secretOf[n]}`,
        )
    }
    if (p.kind === 'basic') notes.push(`${p.secrets[0]} is the base64 of user:password`)
  }
  for (const p of profiles.filter((x) => x.kind === 'clientCredentials')) {
    const paste = profiles.find(
      (x) => x.kind !== 'clientCredentials' && x.schemes.join() === p.schemes.join(),
    )
    notes.push(
      `${p.name} signs in server-side with ${p.secrets.join(' and ')} (dev, test and bundle runs)${paste ? `; a static portal offers ${paste.name} instead` : ''}`,
    )
  }
  return {
    profiles,
    secrets: [...new Set(profiles.flatMap((p) => p.secrets))],
    notes: [...new Set(notes)].slice(0, 4),
    vars,
    environmentVars,
  }
}

/**
 * Turns a document's security schemes into auth profiles whose secrets are filled in at run time, so
 * previewing a protected API only needs the user to paste a key or sign in. Every way the spec accepts is a profile.
 */
export function authFromSpec(
  api: any,
  source?: string,
  servers?: ServerEntry[],
  options: { clientCredentials?: boolean } = {},
): SpecAuth {
  const r = profilesFromSpec(api, {
    naming: 'scheme',
    source,
    servers,
    includeUnreferenced: true,
    clientCredentials: options.clientCredentials,
  })
  const out: SpecAuth = {
    auth: {},
    secrets: {},
    profiles: r.profiles.map((p) => p.name),
    vars: r.vars,
    environmentVars: r.environmentVars,
  }
  for (const p of r.profiles) {
    out.auth[p.name] = {
      title: p.title,
      scheme: p.schemes.length === 1 ? (p.schemes[0] as string) : p.schemes,
      apply: p.apply,
      ...(p.oauth ? { oauth: p.oauth } : {}),
    }
    for (const s of p.secrets) out.secrets[s] = {}
  }
  out.defaultProfile = out.profiles[0]
  return out
}

// ---- the credentials one service needs, for `specbook add` to write into a project's config

export interface SpecCredentials extends SpecProfiles {}

/**
 * How a service's calls authenticate, as the profiles a project can use: every way the spec accepts that a pasted value, a
 * sign-in or a server-side grant can fill, the cheapest first (an API key or bearer token before basic auth before OAuth).
 * Schemes a requirement lists together must all apply, so they share a profile.
 */
export function credentialsFromSpec(
  api: any,
  service: string,
  options: { source?: string; servers?: ServerEntry[] } = {},
): SpecCredentials {
  return profilesFromSpec(api, {
    naming: 'service',
    service,
    source: options.source,
    servers: options.servers,
    clientCredentials: true,
  })
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
