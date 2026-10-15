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

/** What a spec or a config profile declares for an interactive sign-in. */
export interface OAuthSettings {
  authorizationUrl: string
  tokenUrl: string
  /** scope name -> description */
  scopes?: Record<string, string>
  /** a public identifier; pre-fills the sign-in prompt */
  clientId?: string
}

const base64url = (bytes: Uint8Array): string => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const random = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)))

/** `code_challenge` for a verifier: BASE64URL(SHA-256(verifier)). */
export async function challengeFor(verifier: string): Promise<string> {
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
  challenge: string
}): string {
  const url = new URL(o.authorizationUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', o.clientId)
  url.searchParams.set('redirect_uri', o.redirectUri)
  if (o.scopes?.length) url.searchParams.set('scope', o.scopes.join(' '))
  url.searchParams.set('state', o.state)
  url.searchParams.set('code_challenge', o.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
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
    throw new OAuthError(`The token endpoint refused the code: ${r.error}${detail}`)
  }
  if (typeof r.access_token !== 'string' || r.access_token === '')
    throw new OAuthError('The token endpoint returned no access token')
  return {
    accessToken: r.access_token,
    ...(typeof r.expires_in === 'number' ? { expiresIn: r.expires_in } : {}),
    ...(typeof r.scope === 'string' ? { scope: r.scope } : {}),
  }
}
