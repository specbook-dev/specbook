/**
 * Facts about an API that come from its document alone: how it authenticates and where it lives. Shared by
 * the CLI's `preview` and the browser viewer, so both read a spec the same way.
 */

const isUrl = (s: string) => /^https?:\/\//i.test(s)

export interface JsonAuthProfile {
  title: string
  apply: { headers?: Record<string, string>; query?: Record<string, string> }
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
export function authFromSpec(api: any): SpecAuth {
  const schemes: Record<string, any> =
    api.components?.securitySchemes ?? api.securityDefinitions ?? {}
  const out: SpecAuth = { auth: {}, secrets: {} }
  for (const [name, s] of Object.entries(schemes)) {
    const secret = secretName(name)
    const ref = `{{secrets.${secret}}}`
    let apply: JsonAuthProfile['apply'] | undefined
    let title = name
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
      title = `${name} (OAuth, paste an access token)`
    }
    if (!apply) continue
    out.auth[name] = { title, apply }
    out.secrets[secret] = {}
  }
  // the document's top-level `security` says which scheme most operations use
  const top = (api.security as Record<string, unknown>[] | undefined)?.flatMap((r) =>
    Object.keys(r),
  )
  out.defaultProfile = top?.find((n) => out.auth[n]) ?? Object.keys(out.auth)[0]
  return out
}

/** Where the API lives, from `servers[0]` (OpenAPI 3) or `host`/`basePath` (Swagger 2). */
export function liveBaseUrl(api: any, source: string): string | undefined {
  const server = api.servers?.[0]?.url as string | undefined
  if (server) {
    if (isUrl(server)) return server.replace(/\/$/, '')
    if (isUrl(source)) return new URL(server, source).toString().replace(/\/$/, '')
    return undefined
  }
  if (api.host)
    return `${api.schemes?.[0] ?? 'https'}://${api.host}${api.basePath ?? ''}`.replace(/\/$/, '')
  if (isUrl(source)) return new URL(source).origin
  return undefined
}
