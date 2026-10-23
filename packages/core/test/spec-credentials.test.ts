import { describe, expect, it } from 'vitest'
import petstore from '../../../apps/example/openapi/petstore.json'
import petstore2 from '../../codegen/test/fixtures/petstore2.json'
import { credentialsFromSpec, profileNameFor, serviceSecretName } from '../src'

const header = (name: string) => ({ type: 'apiKey', in: 'header', name })
const doc = (schemes: Record<string, unknown>, security?: unknown, paths?: unknown) => ({
  ...(security === undefined ? {} : { security }),
  ...(paths === undefined ? {} : { paths }),
  components: { securitySchemes: schemes },
})

const names = (r: { profiles: { name: string }[] }) => r.profiles.map((p) => p.name)
const first = (r: { profiles: any[] }) => r.profiles[0]

describe('credentialsFromSpec', () => {
  it('puts schemes a requirement lists together in one profile, and every other way in one of its own (Plaid)', () => {
    const api = doc(
      {
        clientId: header('PLAID-CLIENT-ID'),
        secret: header('PLAID-SECRET'),
        plaidVersion: header('Plaid-Version'),
        oauth2: {
          type: 'oauth2',
          flows: { clientCredentials: { tokenUrl: 'https://p.test/t', scopes: {} } },
        },
      },
      [{ clientId: [], secret: [], plaidVersion: [] }],
      {
        '/accounts/get': {
          post: { security: [{ clientId: [], secret: [], plaidVersion: [] }, { oauth2: [] }] },
        },
        '/item/get': { post: {} },
      },
    )
    const r = credentialsFromSpec(api, 'plaid')
    expect(names(r)).toEqual(['plaid', 'plaid-oauth2', 'plaid-oauth2-client'])
    expect(first(r)).toMatchObject({
      title: 'API keys',
      apply: {
        headers: {
          'PLAID-CLIENT-ID': '{{secrets.PLAID_CLIENT_ID}}',
          'PLAID-SECRET': '{{secrets.PLAID_SECRET}}',
          'Plaid-Version': '{{secrets.PLAID_VERSION}}',
        },
      },
      schemes: ['clientId', 'secret', 'plaidVersion'],
      secrets: ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_VERSION'],
    })
    expect(r.profiles[1]).toMatchObject({
      title: 'OAuth token',
      apply: { headers: { authorization: 'Bearer {{secrets.PLAID_OAUTH2}}' } },
      schemes: ['oauth2'],
    })
    expect(r.profiles[1]?.oauth).toBeUndefined()
    expect(r.profiles[2]).toEqual({
      name: 'plaid-oauth2-client',
      title: 'OAuth client credentials',
      apply: { headers: { authorization: 'Bearer {{session.accessToken}}' } },
      schemes: ['oauth2'],
      secrets: ['PLAID_OAUTH2_CLIENT_ID', 'PLAID_OAUTH2_CLIENT_SECRET'],
      kind: 'clientCredentials',
      cost: 3,
      uses: 1,
      serverSide: true,
      oauth: {
        tokenUrl: 'https://p.test/t',
        clientId: '{{secrets.PLAID_OAUTH2_CLIENT_ID}}',
        clientSecret: '{{secrets.PLAID_OAUTH2_CLIENT_SECRET}}',
      },
    })
    expect(r.secrets).toEqual([
      'PLAID_CLIENT_ID',
      'PLAID_SECRET',
      'PLAID_VERSION',
      'PLAID_OAUTH2',
      'PLAID_OAUTH2_CLIENT_ID',
      'PLAID_OAUTH2_CLIENT_SECRET',
    ])
    expect(r.notes[0]).toBe(
      'Plaid-Version reads like a version, not a credential: put its value in PLAID_VERSION',
    )
    expect(r.notes[1]).toContain('plaid-oauth2-client signs in server-side with')
    expect(r.notes[1]).toContain('a static portal offers plaid-oauth2 instead')
  })

  it('lists bearer before basic when the spec accepts either (Stripe)', () => {
    const api = doc(
      {
        basicAuth: { type: 'http', scheme: 'basic' },
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'auth-scheme' },
      },
      [{ basicAuth: [] }, { bearerAuth: [] }],
      { '/v1/charges': { get: {} } },
    )
    const r = credentialsFromSpec(api, 'stripe')
    expect(names(r)).toEqual(['stripe', 'stripe-basic-auth'])
    expect(r.profiles[0]).toMatchObject({
      title: 'bearer token',
      apply: { headers: { authorization: 'Bearer {{secrets.STRIPE_BEARER_AUTH}}' } },
      schemes: ['bearerAuth'],
    })
    expect(r.profiles[1]).toMatchObject({
      title: 'basic auth',
      apply: { headers: { authorization: 'Basic {{secrets.STRIPE_BASIC_AUTH}}' } },
      schemes: ['basicAuth'],
    })
    expect(r.notes).toEqual(['STRIPE_BASIC_AUTH is the base64 of user:password'])
  })

  it('writes the API key and the OAuth sign-in for Petstore', () => {
    const r = credentialsFromSpec(petstore, 'petstore')
    expect(names(r)).toEqual(['petstore', 'petstore-auth'])
    expect(r.profiles[0]).toMatchObject({
      title: 'API key',
      apply: { headers: { api_key: '{{secrets.PETSTORE_API_KEY}}' } },
      schemes: ['api_key'],
      secrets: ['PETSTORE_API_KEY'],
    })
    expect(r.profiles[1]).toMatchObject({
      title: 'OAuth sign-in',
      apply: { headers: { authorization: 'Bearer {{secrets.PETSTORE_AUTH}}' } },
      schemes: ['petstore_auth'],
      oauth: {
        flow: 'implicit',
        authorizationUrl: 'https://petstore3.swagger.io/oauth/authorize',
        scopes: { 'write:pets': 'modify pets in your account', 'read:pets': 'read your pets' },
      },
    })
    expect(r.secrets).toEqual(['PETSTORE_API_KEY', 'PETSTORE_AUTH'])
    expect(r.notes).toEqual([])
  })

  it('reads a Swagger 2 document the same way', () => {
    const r = credentialsFromSpec(petstore2, 'petstore')
    expect(r.secrets).toEqual(['PETSTORE_API_KEY', 'PETSTORE_AUTH'])
    expect(first(r).apply).toEqual({ headers: { api_key: '{{secrets.PETSTORE_API_KEY}}' } })
    expect((r.profiles[1] as any).oauth).toMatchObject({ flow: 'implicit' })
  })

  it('gives services added from the same spec secrets of their own', () => {
    expect(credentialsFromSpec(petstore, 'pets2').secrets[0]).toBe('PETS2_API_KEY')
    expect(credentialsFromSpec(petstore, 'multi').secrets[0]).toBe('MULTI_API_KEY')
  })

  it('writes a query key, and basic auth with a note about the encoding (Swagger 2)', () => {
    const query = {
      securityDefinitions: { key: { type: 'apiKey', in: 'query', name: 'api_key' } },
      security: [{ key: [] }],
    }
    const q = credentialsFromSpec(query, 'legacy')
    expect(first(q)).toMatchObject({
      title: 'API key',
      apply: { query: { api_key: '{{secrets.LEGACY_KEY}}' } },
    })
    expect(q.secrets).toEqual(['LEGACY_KEY'])
    expect(q.notes).toEqual([])
    const basic = { securityDefinitions: { basic: { type: 'basic' } }, security: [{ basic: [] }] }
    const b = credentialsFromSpec(basic, 'legacy')
    expect(first(b)).toMatchObject({
      title: 'basic auth',
      apply: { headers: { authorization: 'Basic {{secrets.LEGACY_BASIC}}' } },
    })
    expect(b.notes).toEqual(['LEGACY_BASIC is the base64 of user:password'])
  })

  it('joins two cookies into one header', () => {
    const api = doc(
      {
        a: { type: 'apiKey', in: 'cookie', name: 'x' },
        b: { type: 'apiKey', in: 'cookie', name: 'y' },
      },
      [{ a: [], b: [] }],
    )
    expect(first(credentialsFromSpec(api, 'site')).apply).toEqual({
      headers: { cookie: 'x={{secrets.SITE_A}}; y={{secrets.SITE_B}}' },
    })
  })

  it('titles a profile by what it sends', () => {
    const mixed = doc({ k: header('X-Key'), t: { type: 'http', scheme: 'bearer' } }, [
      { k: [], t: [] },
    ])
    expect(first(credentialsFromSpec(mixed, 's')).title).toBe('credentials')
    const one = doc({ k: header('X-Key') }, [{ k: [] }])
    expect(first(credentialsFromSpec(one, 's')).title).toBe('API key')
  })

  it('tells two profiles that would read the same apart by their scheme', () => {
    const api = doc({ a: header('X-A'), b: header('X-B') }, [{ a: [] }, { b: [] }])
    expect(credentialsFromSpec(api, 's').profiles.map((p) => p.title)).toEqual([
      'API key (a)',
      'API key (b)',
    ])
  })

  it('gives an OAuth scheme with an authorization code flow a sign-in, with relative addresses as variables', () => {
    const api = doc(
      {
        sso: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'auth',
              tokenUrl: 'token',
              scopes: { read: 'Read' },
            },
          },
        },
      },
      [{ sso: [] }],
    )
    const r = credentialsFromSpec(api, 'acme', {
      servers: [
        { name: 'live', url: 'https://api.test/v1' },
        { name: 'sandbox', url: 'https://sandbox.test/v1' },
      ],
    })
    expect(first(r).apply).toEqual({ headers: { authorization: 'Bearer {{secrets.ACME_SSO}}' } })
    expect(first(r).title).toBe('OAuth sign-in')
    expect(first(r).oauth).toEqual({
      authorizationUrl: '{{acmeSsoAuthorizationUrl}}',
      tokenUrl: '{{acmeSsoTokenUrl}}',
      scopes: { read: 'Read' },
    })
    expect(r.vars).toEqual({
      acmeSsoAuthorizationUrl: 'https://api.test/v1/auth',
      acmeSsoTokenUrl: 'https://api.test/v1/token',
    })
    expect(r.environmentVars).toEqual({
      sandbox: {
        acmeSsoAuthorizationUrl: 'https://sandbox.test/v1/auth',
        acmeSsoTokenUrl: 'https://sandbox.test/v1/token',
      },
    })
  })

  it('reads an OpenID Connect scheme as a sign-in by discovery, and an OAuth scheme with only a password flow as a pasted token', () => {
    const oidc = doc(
      {
        id: {
          type: 'openIdConnect',
          openIdConnectUrl: 'https://id.test/.well-known/openid-configuration',
        },
      },
      [{ id: [] }],
    )
    expect(first(credentialsFromSpec(oidc, 'a')).oauth).toEqual({
      openIdConnectUrl: 'https://id.test/.well-known/openid-configuration',
    })
    const pw = doc({ p: { type: 'oauth2', flows: { password: { tokenUrl: 't', scopes: {} } } } }, [
      { p: [] },
    ])
    const r = credentialsFromSpec(pw, 'a')
    expect(first(r).oauth).toBeUndefined()
    expect(first(r).title).toBe('OAuth token')
    expect(names(r)).toEqual(['a'])
  })

  it('reads a Swagger 2 application flow as client credentials', () => {
    const api = {
      securityDefinitions: {
        app: {
          type: 'oauth2',
          flow: 'application',
          tokenUrl: 'https://t.test/token',
          scopes: { x: 'X' },
        },
      },
      security: [{ app: [] }],
    }
    const r = credentialsFromSpec(api, 'svc')
    expect(names(r)).toEqual(['svc', 'svc-client'])
    expect((r.profiles[1] as any).oauth).toEqual({
      tokenUrl: 'https://t.test/token',
      clientId: '{{secrets.SVC_APP_CLIENT_ID}}',
      clientSecret: '{{secrets.SVC_APP_CLIENT_SECRET}}',
    })
  })

  it('writes nothing for a scheme that cannot be a header or a query value', () => {
    const r = credentialsFromSpec(doc({ mtls: { type: 'mutualTLS' } }, [{ mtls: [] }]), 'x')
    expect(r.profiles).toEqual([])
    expect(r.secrets).toEqual([])
    expect(r.notes).toEqual(['mtls cannot be sent as a header or a query value'])
  })

  it('says when two schemes would set the same header', () => {
    const api = doc(
      { b: { type: 'http', scheme: 'bearer' }, c: { type: 'http', scheme: 'basic' } },
      [{ b: [], c: [] }],
    )
    const r = credentialsFromSpec(api, 'x')
    expect(r.profiles).toEqual([])
    expect(r.notes).toEqual(['b and c would set the same header, so they are not written'])
  })

  it('ignores an optional-auth entry and a document that secures nothing', () => {
    const k = { k: header('X-Key') }
    expect(credentialsFromSpec(doc(k, [{}, { k: [] }]), 's').secrets).toEqual(['S_K'])
    for (const none of [doc(k, []), doc(k), { paths: {} }])
      expect(credentialsFromSpec(none, 's')).toMatchObject({ profiles: [], secrets: [], notes: [] })
  })

  it('says when a requirement names a scheme the document does not define', () => {
    const r = credentialsFromSpec(doc({ k: header('X-Key') }, [{ ghost: [] }]), 's')
    expect(r.profiles).toEqual([])
    expect(r.notes[0]).toContain('ghost is not defined in the document itself')
  })

  it('follows a local reference to a scheme and says an outside one is not read', () => {
    const local = {
      security: [{ k: [] }],
      components: {
        securitySchemes: { k: { $ref: '#/components/schemas/real' } },
        schemas: { real: header('X-Key') },
      },
    }
    expect(first(credentialsFromSpec(local, 's')).apply).toEqual({
      headers: { 'X-Key': '{{secrets.S_K}}' },
    })
    const outside = doc({ k: { $ref: 'other.yaml#/k' }, j: header('X-J') }, [{ k: [] }, { j: [] }])
    const r = credentialsFromSpec(outside, 's')
    expect(r.secrets).toEqual(['S_J'])
    expect(r.notes[0]).toContain('k is not defined in the document itself')
  })

  it('keeps two schemes of one service from sharing a secret', () => {
    const api = doc({ 'a-b': header('X-1'), a_b: header('X-2') }, [{ 'a-b': [], a_b: [] }])
    expect(credentialsFromSpec(api, 'svc').secrets).toEqual(['SVC_A_B', 'SVC_A_B_2'])
  })

  it('orders ways by what a pasted value costs, then by how many operations take them', () => {
    const api = doc(
      { a: header('X-A'), b: header('X-B'), t: { type: 'http', scheme: 'bearer' } },
      undefined,
      {
        '/1': { get: { security: [{ a: [] }] } },
        '/2': { get: { security: [{ b: [] }] } },
        '/3': { get: { security: [{ b: [] }] } },
        '/4': { get: { security: [{ t: [] }] } },
      },
    )
    // b is taken by two operations, a by one, t (a bearer token) costs the same as a key
    expect(credentialsFromSpec(api, 's').profiles.map((p) => p.schemes[0])).toEqual(['b', 'a', 't'])
  })
})

describe('profileNameFor', () => {
  it.each([
    ['petstore', ['petstore_auth'], 'petstore-auth'],
    ['stripe', ['basicAuth'], 'stripe-basic-auth'],
    ['plaid', ['oauth2'], 'plaid-oauth2'],
    ['pet', ['petstore_auth'], 'pet-petstore-auth'],
    ['svc', ['a', 'b'], 'svc-a-b'],
    ['stripe', ['stripe'], 'stripe-key'],
  ])('%s + %j is %s', (service, schemes, name) => {
    expect(profileNameFor(service, schemes)).toBe(name)
  })
})

describe('serviceSecretName', () => {
  it.each([
    ['plaid', 'clientId', 'PLAID_CLIENT_ID'],
    ['plaid', 'secret', 'PLAID_SECRET'],
    ['plaid', 'plaidVersion', 'PLAID_VERSION'],
    ['petstore', 'api_key', 'PETSTORE_API_KEY'],
    ['petstore', 'petstore_auth', 'PETSTORE_AUTH'],
    ['pet', 'petstore_auth', 'PET_PETSTORE_AUTH'],
    ['stripe', 'bearerAuth', 'STRIPE_BEARER_AUTH'],
    ['stripe', 'stripe', 'STRIPE_KEY'],
    ['acme', 'HTTPBearer', 'ACME_HTTP_BEARER'],
    ['my-api', 'x-api-key', 'MY_API_X_API_KEY'],
    ['pets2', 'api_key', 'PETS2_API_KEY'],
    ['svc', '---', 'SVC_API_KEY'],
  ])('%s + %s is %s', (service, scheme, name) => {
    expect(serviceSecretName(service, scheme)).toBe(name)
    expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
  })
})
