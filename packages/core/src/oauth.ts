/**
 * OAuth 2.0 authorization code with PKCE (RFC 7636), as pure helpers over Web Crypto so the browser and
 * Node run the same code. Nothing here stores anything: a verifier is held by the caller, in memory.
 */

export class OAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthError'
  }
}

/**
 * The endpoints are written out: an OAuth 2.0 sign-in. `flow` defaults to the authorization code with PKCE; the implicit
 * flow (a legacy flow some demo APIs still use) has no token endpoint, the token comes back in the address.
 */
export interface OAuthEndpoints {
  authorizationUrl: string
  tokenUrl?: string
  flow?: 'authorizationCode' | 'implicit'
  /** scope name -> description */
  scopes?: Record<string, string>
  /** a public identifier; pre-fills the sign-in prompt */
  clientId?: string
}

/** The endpoints are found in an OpenID Connect discovery document. */
export interface OAuthDiscovery {
  openIdConnectUrl: string
  scopes?: Record<string, string>
  clientId?: string
}

/**
 * A token fetched by the runner itself, with no person: the client credentials grant. `clientId` and `clientSecret`
 * are usually `{{secrets.NAME}}` placeholders; the secret is only ever filled by a server (the CLI, a bundle, the dev proxy).
 */
export interface OAuthClientCredentials {
  tokenUrl: string
  clientId: string
  clientSecret: string
  scopes?: Record<string, string>
  /** Where the client's credentials go in the token request. `basic` needs the values in hand, so a browser run sends the body form. */
  clientAuth?: 'body' | 'basic'
}

/** What a spec or a config profile declares: an interactive sign-in, or a token the runner fetches. */
export type OAuthSettings = OAuthEndpoints | OAuthDiscovery | OAuthClientCredentials

export const isClientCredentials = (o: OAuthSettings): o is OAuthClientCredentials =>
  'clientSecret' in o
export const isDiscovery = (o: OAuthSettings): o is OAuthDiscovery => 'openIdConnectUrl' in o

/** The reserved service names a token exchange and a discovery document are addressed to. */
export const AUTH_SERVICE_PREFIX = 'auth:'
export const DISCOVERY_SERVICE_PREFIX = 'discovery:'
export const authServiceName = (profile: string): string =>
  `${AUTH_SERVICE_PREFIX}${encodeURIComponent(profile)}`
export function profileOfAuthService(service: string): string | undefined {
  if (!service.startsWith(AUTH_SERVICE_PREFIX)) return undefined
  const raw = service.slice(AUTH_SERVICE_PREFIX.length)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Endpoints read from a discovery document. */
export interface DiscoveredEndpoints {
  authorizationUrl: string
  tokenUrl: string
  /** scope name -> '' (a discovery document lists names only) */
  scopes: Record<string, string>
}

/**
 * The two endpoints a sign-in needs, from `/.well-known/openid-configuration`. Only the access token is
 * used, so nothing else in the document (ID-token signing keys, `nonce` support) matters here.
 */
export function parseDiscovery(json: unknown): DiscoveredEndpoints {
  const d = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const url = (v: unknown) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : undefined)
  const authorizationUrl = url(d.authorization_endpoint)
  const tokenUrl = url(d.token_endpoint)
  if (!authorizationUrl || !tokenUrl)
    throw new OAuthError('The provider’s discovery document has no authorization or token endpoint')
  const supported = Array.isArray(d.scopes_supported)
    ? d.scopes_supported.filter((x): x is string => typeof x === 'string')
    : []
  // `openid` is what makes it an OpenID Connect request; list it first even when the document omits it
  const names = ['openid', ...supported.filter((x) => x !== 'openid')]
  return { authorizationUrl, tokenUrl, scopes: Object.fromEntries(names.map((n) => [n, ''])) }
}

const base64url = (bytes: Uint8Array): string => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const random = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)))

/** `code_challenge` for a verifier: BASE64URL(SHA-256(verifier)). */
export async function challengeFor(verifier: string): Promise<string> {
  // WebCrypto's `subtle` exists only on a secure page (https, or localhost); a viewer served over plain
  // http, or framed inside such a page, has none. Say so, rather than fail on `undefined.digest`.
  if (!globalThis.crypto?.subtle)
    throw new OAuthError(
      'Sign-in needs a secure page (https, or localhost). Open the viewer over https, or paste an access token.',
    )
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

/** A fresh verifier (64 characters from the unreserved set) and its S256 challenge. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = random(48)
  return { verifier, challenge: await challengeFor(verifier) }
}

export const newState = (): string => random(24)

export function authorizeUrl(o: {
  authorizationUrl: string
  clientId: string
  redirectUri: string
  scopes?: string[]
  state: string
  /** The PKCE challenge; omitted for the implicit flow, which has none. */
  challenge?: string
  responseType?: 'code' | 'token'
}): string {
  const implicit = o.responseType === 'token'
  if (!implicit && !o.challenge) throw new OAuthError('A code sign-in needs a PKCE challenge')
  const url = new URL(o.authorizationUrl)
  url.searchParams.set('response_type', implicit ? 'token' : 'code')
  url.searchParams.set('client_id', o.clientId)
  url.searchParams.set('redirect_uri', o.redirectUri)
  if (o.scopes?.length) url.searchParams.set('scope', o.scopes.join(' '))
  url.searchParams.set('state', o.state)
  if (!implicit) {
    url.searchParams.set('code_challenge', o.challenge as string)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  return url.toString()
}

/** The token from an implicit-flow redirect (read from the address fragment), once `state` has been checked. */
export function parseImplicitCallback(
  params: URLSearchParams | Record<string, string | null | undefined>,
  expectedState: string,
): { accessToken: string; expiresIn?: number; scope?: string } {
  const get = (k: string) =>
    (params instanceof URLSearchParams ? params.get(k) : params[k]) ?? undefined
  const error = get('error')
  if (error) {
    const detail = get('error_description')
    throw new OAuthError(`Sign-in was refused: ${detail ? `${error} (${detail})` : error}`)
  }
  if (get('state') !== expectedState)
    throw new OAuthError('Sign-in was rejected: the response did not match this request (state)')
  const accessToken = get('access_token')
  if (!accessToken) throw new OAuthError('Sign-in returned no access token')
  const expires = Number(get('expires_in'))
  const scope = get('scope')
  return {
    accessToken,
    ...(Number.isFinite(expires) && get('expires_in') ? { expiresIn: expires } : {}),
    ...(scope ? { scope } : {}),
  }
}

/** The fields of a client credentials token request. */
export function clientCredentialsFields(o: {
  clientId: string
  clientSecret: string
  scopes?: string[]
  basic?: boolean
}): Record<string, string> {
  return {
    grant_type: 'client_credentials',
    ...(o.scopes?.length ? { scope: o.scopes.join(' ') } : {}),
    ...(o.basic ? {} : { client_id: o.clientId, client_secret: o.clientSecret }),
  }
}

/** The code from the redirect, once `state` has been checked; throws what the server or the check said. */
export function parseCallback(
  params: URLSearchParams | Record<string, string | null | undefined>,
  expectedState: string,
): { code: string } {
  const get = (k: string) =>
    (params instanceof URLSearchParams ? params.get(k) : params[k]) ?? undefined
  const error = get('error')
  if (error) {
    const detail = get('error_description')
    throw new OAuthError(`Sign-in was refused: ${detail ? `${error} (${detail})` : error}`)
  }
  if (get('state') !== expectedState)
    throw new OAuthError('Sign-in was rejected: the response did not match this request (state)')
  const code = get('code')
  if (!code) throw new OAuthError('Sign-in returned no authorization code')
  return { code }
}

/** The form fields of the code exchange. A public client sends the verifier and no client secret. */
export function tokenRequestFields(o: {
  code: string
  verifier: string
  clientId: string
  redirectUri: string
}): Record<string, string> {
  return {
    grant_type: 'authorization_code',
    code: o.code,
    redirect_uri: o.redirectUri,
    client_id: o.clientId,
    code_verifier: o.verifier,
  }
}

export const tokenRequestBody = (o: Parameters<typeof tokenRequestFields>[0]): string =>
  new URLSearchParams(tokenRequestFields(o)).toString()

export function parseTokenResponse(json: unknown): {
  accessToken: string
  expiresIn?: number
  scope?: string
} {
  const r = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  if (typeof r.error === 'string') {
    const detail = typeof r.error_description === 'string' ? ` (${r.error_description})` : ''
    throw new OAuthError(`The token endpoint refused the request: ${r.error}${detail}`)
  }
  if (typeof r.access_token !== 'string' || r.access_token === '')
    throw new OAuthError('The token endpoint returned no access token')
  return {
    accessToken: r.access_token,
    ...(typeof r.expires_in === 'number' ? { expiresIn: r.expires_in } : {}),
    ...(typeof r.scope === 'string' ? { scope: r.scope } : {}),
  }
}
