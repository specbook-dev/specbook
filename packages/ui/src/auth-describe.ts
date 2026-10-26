import type { SecurityRequirement } from '@specbook/core/internal'

/**
 * Words for what the spec says about an operation's credentials, from the manifest's compact `security` (the ways it
 * accepts) and `securitySchemes` (what each scheme is). Pure, so the Docs tab and the catalog's lock agree.
 */

export interface SchemeInfo {
  type: string
  in?: string
  name?: string
  scheme?: string
  openIdConnectUrl?: string
  flows?: Record<string, { scopes: string[] }>
}

export interface Part {
  scheme: string
  /** how it is sent: `API key in header "api_key"`, `OAuth 2.0 (implicit)` */
  how: string
  scopes: string[]
}

const FLOW: Record<string, string> = {
  authorizationCode: 'authorization code',
  implicit: 'implicit',
  clientCredentials: 'client credentials',
  password: 'password',
}

export function describeScheme(info: SchemeInfo | undefined): string {
  if (!info) return 'a scheme the document does not define'
  if (info.type === 'apiKey') return `API key in ${info.in ?? 'header'} "${info.name ?? ''}"`
  if (info.type === 'http') {
    const s = (info.scheme ?? '').toLowerCase()
    return s === 'bearer' ? 'bearer token' : s === 'basic' ? 'basic auth' : `HTTP ${s || 'auth'}`
  }
  if (info.type === 'basic') return 'basic auth'
  if (info.type === 'oauth2') {
    const flows = Object.keys(info.flows ?? {}).map((f) => FLOW[f] ?? f)
    return flows.length ? `OAuth 2.0 (${flows.join(', ')})` : 'OAuth 2.0'
  }
  if (info.type === 'openIdConnect') return 'OpenID Connect'
  if (info.type === 'mutualTLS') return 'mutual TLS'
  return info.type
}

/** The alternatives an operation accepts (any one is enough), each as the schemes that apply together. */
export function describeSecurity(
  security: SecurityRequirement[] | undefined,
  schemes: Record<string, SchemeInfo> | undefined,
): Part[][] {
  return (security ?? [])
    .map((req) =>
      Object.entries(req).map(([scheme, scopes]) => ({
        scheme,
        how: describeScheme(schemes?.[scheme]),
        scopes,
      })),
    )
    .filter((parts) => parts.length > 0)
}

/** One line for a tooltip: `Needs credentials: api_key or petstore_auth (write:pets, read:pets)`. */
export function lockTitle(
  security: SecurityRequirement[] | undefined,
  schemes: Record<string, SchemeInfo> | undefined,
): string {
  const alts = describeSecurity(security, schemes)
  if (!alts.length) return 'Needs credentials'
  const text = alts
    .map((parts) =>
      parts
        .map((p) => {
          const shown = p.scopes.slice(0, 3).join(', ')
          return p.scopes.length
            ? `${p.scheme} (${shown}${p.scopes.length > 3 ? ', …' : ''})`
            : p.scheme
        })
        .join(' + '),
    )
    .join(' or ')
  return `Needs credentials: ${text}`
}

/** The scopes the operations want of any of `schemes`: what a sign-in for that scheme should ask for. */
export function requiredScopes(
  securities: (boolean | SecurityRequirement[] | undefined)[],
  schemes: string[],
): string[] {
  const out = new Set<string>()
  for (const security of securities)
    if (Array.isArray(security))
      for (const req of security)
        for (const [scheme, scopes] of Object.entries(req))
          if (schemes.includes(scheme)) for (const s of scopes) out.add(s)
  return [...out]
}
