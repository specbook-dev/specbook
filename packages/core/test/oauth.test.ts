import { describe, expect, it } from 'vitest'
import {
  authFromSpec,
  authorizeUrl,
  challengeFor,
  createPkce,
  newState,
  OAuthError,
  parseCallback,
  parseTokenResponse,
  tokenRequestBody,
} from '../src'

describe('PKCE', () => {
  it('derives the challenge from the RFC 7636 appendix B example', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('makes a verifier from the unreserved set, long enough, and a matching challenge', async () => {
    const a = await createPkce()
    const b = await createPkce()
    expect(a.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).toBe(await challengeFor(a.verifier))
    expect(newState()).not.toBe(newState())
  })
})

describe('authorizeUrl', () => {
  it('asks for a code with S256, the state and the scopes, keeping the URL’s own query', () => {
    const url = new URL(
      authorizeUrl({
        authorizationUrl: 'https://auth.example.com/authorize?audience=api',
        clientId: 'cid',
        redirectUri: 'https://ui.example.com/',
        scopes: ['read', 'write'],
        state: 'st',
        challenge: 'ch',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://auth.example.com/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      audience: 'api',
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'https://ui.example.com/',
      scope: 'read write',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    })
  })
})

describe('parseCallback', () => {
  it('returns the code when state matches', () => {
    expect(parseCallback(new URLSearchParams('code=abc&state=s1'), 's1')).toEqual({ code: 'abc' })
  })

  it('rejects a state mismatch', () => {
    expect(() => parseCallback({ code: 'abc', state: 'other' }, 's1')).toThrow(/state/)
  })

  it('rejects a missing state even when a code is present', () => {
    expect(() => parseCallback({ code: 'abc' }, 's1')).toThrow(OAuthError)
  })

  it('says what the server refused', () => {
    expect(() =>
      parseCallback(
        { error: 'access_denied', error_description: 'user said no', state: 's1' },
        's1',
      ),
    ).toThrow(/access_denied \(user said no\)/)
  })
})

describe('token exchange', () => {
  it('builds a form body with the verifier and no client secret', () => {
    const body = new URLSearchParams(
      tokenRequestBody({ code: 'c', verifier: 'v', clientId: 'cid', redirectUri: 'https://x/' }),
    )
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://x/',
      client_id: 'cid',
      code_verifier: 'v',
    })
  })

  it('reads the token, expiry and scope', () => {
    expect(
      parseTokenResponse({
        access_token: 't',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'a b',
      }),
    ).toEqual({ accessToken: 't', expiresIn: 3600, scope: 'a b' })
  })

  it('refuses an error body and a body with no token', () => {
    expect(() => parseTokenResponse({ error: 'invalid_grant' })).toThrow(/invalid_grant/)
    expect(() => parseTokenResponse({})).toThrow(/no access token/)
    expect(() => parseTokenResponse(null)).toThrow(OAuthError)
  })
})

describe('authFromSpec: OAuth schemes', () => {
  const v3 = (flows: object) => ({
    components: { securitySchemes: { petAuth: { type: 'oauth2', flows } } },
  })

  it('reads the authorization code flow of an OpenAPI 3 document', () => {
    const r = authFromSpec(
      v3({
        authorizationCode: {
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          scopes: { 'read:pets': 'read pets' },
        },
      }),
    )
    expect(r.auth.petAuth?.oauth).toEqual({
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      scopes: { 'read:pets': 'read pets' },
    })
    // the pasted-token path is unchanged
    expect(r.auth.petAuth?.apply).toEqual({
      headers: { authorization: 'Bearer {{secrets.PETAUTH}}' },
    })
  })

  it('reads a Swagger 2 accessCode flow and resolves relative URLs against the source', () => {
    const r = authFromSpec(
      {
        securityDefinitions: {
          o: {
            type: 'oauth2',
            flow: 'accessCode',
            authorizationUrl: '/oauth/authorize',
            tokenUrl: '/oauth/token',
          },
        },
      },
      'https://api.example.com/spec.json',
    )
    expect(r.auth.o?.oauth?.authorizationUrl).toBe('https://api.example.com/oauth/authorize')
    expect(r.auth.o?.oauth?.tokenUrl).toBe('https://api.example.com/oauth/token')
  })

  it('leaves implicit, client credentials and password flows as paste-only', () => {
    for (const flows of [
      { implicit: { authorizationUrl: 'https://a/authorize', scopes: {} } },
      { clientCredentials: { tokenUrl: 'https://a/token', scopes: {} } },
      { password: { tokenUrl: 'https://a/token', scopes: {} } },
    ]) {
      const r = authFromSpec(v3(flows))
      expect(r.auth.petAuth).toBeDefined()
      expect(r.auth.petAuth?.oauth).toBeUndefined()
    }
  })
})
