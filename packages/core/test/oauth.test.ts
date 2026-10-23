import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authFromSpec,
  authorizeUrl,
  authServiceName,
  challengeFor,
  clientCredentialsFields,
  createPkce,
  isClientCredentials,
  isDiscovery,
  newState,
  OAuthError,
  parseCallback,
  parseDiscovery,
  parseImplicitCallback,
  parseTokenResponse,
  profileOfAuthService,
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

describe('PKCE on a page that is not secure', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('says the page must be secure, instead of failing on a missing digest', async () => {
    // an http page, or one framed inside it: random values exist, `subtle` does not
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    })
    await expect(createPkce()).rejects.toThrow(/secure page \(https, or localhost\)/)
    await expect(createPkce()).rejects.toBeInstanceOf(OAuthError)
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
    expect(r.auth.o?.oauth).toMatchObject({
      authorizationUrl: 'https://api.example.com/oauth/authorize',
      tokenUrl: 'https://api.example.com/oauth/token',
    })
  })

  it('reads the implicit flow as a sign-in with no token endpoint', () => {
    const r = authFromSpec(
      v3({ implicit: { authorizationUrl: 'https://a/authorize', scopes: { read: 'Read' } } }),
    )
    expect(r.auth.petAuth?.oauth).toEqual({
      flow: 'implicit',
      authorizationUrl: 'https://a/authorize',
      scopes: { read: 'Read' },
    })
  })

  it('prefers the authorization code flow when a scheme offers both', () => {
    const r = authFromSpec(
      v3({
        implicit: { authorizationUrl: 'https://a/authorize', scopes: {} },
        authorizationCode: {
          authorizationUrl: 'https://a/authorize',
          tokenUrl: 'https://a/token',
          scopes: {},
        },
      }),
    )
    expect(r.auth.petAuth?.oauth).toEqual({
      authorizationUrl: 'https://a/authorize',
      tokenUrl: 'https://a/token',
    })
  })

  it('leaves client credentials and password flows as paste-only in the viewer', () => {
    for (const flows of [
      { clientCredentials: { tokenUrl: 'https://a/token', scopes: {} } },
      { password: { tokenUrl: 'https://a/token', scopes: {} } },
    ]) {
      const r = authFromSpec(v3(flows))
      expect(r.auth.petAuth).toBeDefined()
      expect(r.auth.petAuth?.oauth).toBeUndefined()
    }
  })

  it('offers a client credentials profile when asked (a server can hold the secret)', () => {
    const r = authFromSpec(
      v3({ clientCredentials: { tokenUrl: 'https://a/token', scopes: { read: 'Read' } } }),
      undefined,
      undefined,
      { clientCredentials: true },
    )
    expect(r.profiles).toEqual(['petAuth', 'petAuth-client'])
    expect(r.auth['petAuth-client']?.oauth).toEqual({
      tokenUrl: 'https://a/token',
      clientId: '{{secrets.PETAUTH_CLIENT_ID}}',
      clientSecret: '{{secrets.PETAUTH_CLIENT_SECRET}}',
    })
  })
})

describe('OpenID Connect', () => {
  it('reads the endpoints and scope names from a discovery document, openid first', () => {
    const found = parseDiscovery({
      issuer: 'https://accounts.example.com',
      authorization_endpoint: 'https://accounts.example.com/o/authorize',
      token_endpoint: 'https://oauth2.example.com/token',
      scopes_supported: ['email', 'profile', 'openid'],
    })
    expect(found.authorizationUrl).toBe('https://accounts.example.com/o/authorize')
    expect(found.tokenUrl).toBe('https://oauth2.example.com/token')
    expect(Object.keys(found.scopes)).toEqual(['openid', 'email', 'profile'])
  })

  it('offers openid even when the document lists no scopes', () => {
    const found = parseDiscovery({
      authorization_endpoint: 'https://a.example.com/authorize',
      token_endpoint: 'https://a.example.com/token',
    })
    expect(Object.keys(found.scopes)).toEqual(['openid'])
  })

  it('refuses a document with no usable endpoints', () => {
    expect(() => parseDiscovery({})).toThrow(OAuthError)
    expect(() =>
      parseDiscovery({
        authorization_endpoint: 'javascript:alert(1)',
        token_endpoint: 'https://t/',
      }),
    ).toThrow(/no authorization or token endpoint/)
  })

  it('turns an openIdConnect scheme into a sign-in, resolving a relative discovery URL', () => {
    const api = (openIdConnectUrl: string) => ({
      components: { securitySchemes: { sso: { type: 'openIdConnect', openIdConnectUrl } } },
    })
    const abs = authFromSpec(api('https://accounts.example.com/.well-known/openid-configuration'))
    expect(abs.auth.sso?.oauth).toEqual({
      openIdConnectUrl: 'https://accounts.example.com/.well-known/openid-configuration',
    })
    expect(abs.auth.sso?.title).toContain('sign in or paste')
    expect(abs.auth.sso?.apply).toEqual({
      headers: { authorization: 'Bearer {{secrets.SSO}}' },
    })

    const rel = authFromSpec(
      api('/.well-known/openid-configuration'),
      'https://api.example.com/spec.json',
    )
    expect(rel.auth.sso?.oauth).toEqual({
      openIdConnectUrl: 'https://api.example.com/.well-known/openid-configuration',
    })
  })

  it('stays paste-only when the scheme names no discovery URL', () => {
    const r = authFromSpec({ components: { securitySchemes: { sso: { type: 'openIdConnect' } } } })
    expect(r.auth.sso).toBeDefined()
    expect(r.auth.sso?.oauth).toBeUndefined()
  })
})

describe('the implicit flow', () => {
  const base = {
    authorizationUrl: 'https://a.test/authorize?tenant=1',
    clientId: 'cid',
    redirectUri: 'https://app.test/cb',
    scopes: ['read', 'write'],
    state: 's1',
  }

  it('asks for a token, with no PKCE challenge', () => {
    const q = new URL(authorizeUrl({ ...base, responseType: 'token' })).searchParams
    expect(q.get('response_type')).toBe('token')
    expect(q.get('scope')).toBe('read write')
    expect(q.get('state')).toBe('s1')
    expect(q.get('tenant')).toBe('1')
    expect(q.has('code_challenge')).toBe(false)
  })

  it('refuses to build a code request without a challenge', () => {
    expect(() => authorizeUrl(base)).toThrow(/PKCE challenge/)
  })

  it('reads the token from the fragment once state matches', () => {
    expect(
      parseImplicitCallback(
        new URLSearchParams('access_token=t&expires_in=300&scope=read&state=s1&token_type=Bearer'),
        's1',
      ),
    ).toEqual({ accessToken: 't', expiresIn: 300, scope: 'read' })
    expect(parseImplicitCallback({ access_token: 't', state: 's1' }, 's1')).toEqual({
      accessToken: 't',
    })
  })

  it('rejects another state, a refusal, and a response with no token', () => {
    expect(() => parseImplicitCallback({ access_token: 't', state: 'other' }, 's1')).toThrow(
      /state/,
    )
    expect(() =>
      parseImplicitCallback({ error: 'access_denied', error_description: 'no', state: 's1' }, 's1'),
    ).toThrow(/access_denied \(no\)/)
    expect(() => parseImplicitCallback({ state: 's1' }, 's1')).toThrow(/no access token/)
  })
})

describe('client credentials and the reserved auth service', () => {
  it('builds the form of a token request, with the credentials in the body unless basic', () => {
    expect(
      clientCredentialsFields({ clientId: 'i', clientSecret: 's', scopes: ['a', 'b'] }),
    ).toEqual({
      grant_type: 'client_credentials',
      scope: 'a b',
      client_id: 'i',
      client_secret: 's',
    })
    expect(clientCredentialsFields({ clientId: 'i', clientSecret: 's', basic: true })).toEqual({
      grant_type: 'client_credentials',
    })
  })

  it('addresses a profile as a service and reads the profile back', () => {
    expect(authServiceName('My OAuth')).toBe('auth:My%20OAuth')
    expect(profileOfAuthService('auth:My%20OAuth')).toBe('My OAuth')
    expect(profileOfAuthService('petstore')).toBeUndefined()
  })

  it('tells the settings apart by shape', () => {
    const cc = { tokenUrl: 't', clientId: 'i', clientSecret: 's' }
    expect(isClientCredentials(cc)).toBe(true)
    expect(isClientCredentials({ authorizationUrl: 'a' })).toBe(false)
    expect(isDiscovery({ openIdConnectUrl: 'o' })).toBe(true)
  })
})
