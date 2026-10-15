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

/** An OpenID Connect scheme: the discovery document says where to sign in. */
function discovery(s: any, base: string | undefined): OAuthSettings | undefined {
  if (typeof s.openIdConnectUrl !== 'string' || s.openIdConnectUrl === '') return undefined
  try {
    return { openIdConnectUrl: new URL(s.openIdConnectUrl, base).toString() }
  } catch {
    return undefined
  }
}

/** The authorization code flow of an OAuth scheme (OpenAPI 3 `flows`, or Swagger 2 `accessCode`). */
function codeFlow(s: any, base: string | undefined): OAuthSettings | undefined {
  const flow = s.flows?.authorizationCode ?? (s.flow === 'accessCode' ? s : undefined)
  if (!flow?.authorizationUrl || !flow?.tokenUrl) return undefined
  const abs = (u: string) => {
    try {
      return new URL(u, base).toString()
    } catch {
      return u
    }
  }
  return {
    authorizationUrl: abs(flow.authorizationUrl),
    tokenUrl: abs(flow.tokenUrl),
    ...(flow.scopes && Object.keys(flow.scopes).length ? { scopes: flow.scopes } : {}),
  }
}

export interface SpecAuth {
  auth: Record<string, JsonAuthProfile>
  /** secret name -> {} (values come from the UI or the environment) */
  secrets: Record<string, Record<string, never>>
  /** the profile requests use unless they say otherwise */
  defaultProfile?: string
}

const secretName = (scheme: string) =>
  scheme
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || 'API_KEY'

/**
 * Turns a document's security schemes into auth profiles whose secrets are filled in at run time, so
 * previewing a protected API only needs the user to paste a key. OAuth-style schemes take an access token.
 */
export function authFromSpec(api: any, source?: string): SpecAuth {
  const schemes: Record<string, any> =
    api.components?.securitySchemes ?? api.securityDefinitions ?? {}
  const out: SpecAuth = { auth: {}, secrets: {} }
  for (const [name, s] of Object.entries(schemes)) {
    const secret = secretName(name)
    const ref = `{{secrets.${secret}}}`
    let apply: JsonAuthProfile['apply'] | undefined
    let title = name
    let oauth: OAuthSettings | undefined
    if (s.type === 'apiKey') {
      const key = s.name as string
      if (s.in === 'header') apply = { headers: { [key]: ref } }
      else if (s.in === 'query') apply = { query: { [key]: ref } }
      else if (s.in === 'cookie') apply = { headers: { cookie: `${key}=${ref}` } }
      title = `${name} (API key, ${s.in} "${key}")`
    } else if (s.type === 'http' && /^bearer$/i.test(s.scheme)) {
      apply = { headers: { authorization: `Bearer ${ref}` } }
      title = `${name} (bearer token)`
    } else if (s.type === 'http' && /^basic$/i.test(s.scheme)) {
      // the template language has no base64, so the user pastes the encoded `user:password`
      apply = { headers: { authorization: `Basic ${ref}` } }
      title = `${name} (basic auth, paste base64 of user:password)`
    } else if (s.type === 'basic') {
      apply = { headers: { authorization: `Basic ${ref}` } }
      title = `${name} (basic auth, paste base64 of user:password)`
    } else if (s.type === 'oauth2' || s.type === 'openIdConnect') {
      apply = { headers: { authorization: `Bearer ${ref}` } }
      const base = source && isUrl(source) ? source : undefined
      oauth = s.type === 'oauth2' ? codeFlow(s, base) : discovery(s, base)
      title = `${name} (OAuth, ${oauth ? 'sign in or ' : ''}paste an access token)`
    }
    if (!apply) continue
    out.auth[name] = { title, apply, ...(oauth ? { oauth } : {}) }
    out.secrets[secret] = {}
  }
  // the document's top-level `security` says which scheme most operations use
  const top = (api.security as Record<string, unknown>[] | undefined)?.flatMap((r) =>
    Object.keys(r),
  )
  out.defaultProfile = top?.find((n) => out.auth[n]) ?? Object.keys(out.auth)[0]
  return out
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

/** Where the API lives, from `servers[0]` (OpenAPI 3) or `host`/`basePath` (Swagger 2). */
export function liveBaseUrl(api: any, source: string): string | undefined {
  return openApiServers(api, source).servers.find((s) => s.name === 'live')?.url
}
