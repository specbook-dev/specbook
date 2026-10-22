import { describe, expect, it } from 'vitest'
import petstore from '../../../apps/example/openapi/petstore.json'
import petstore2 from '../../codegen/test/fixtures/petstore2.json'
import { credentialsFromSpec, serviceSecretName } from '../src'

const header = (name: string) => ({ type: 'apiKey', in: 'header', name })
const doc = (schemes: Record<string, unknown>, security?: unknown, paths?: unknown) => ({
  ...(security === undefined ? {} : { security }),
  ...(paths === undefined ? {} : { paths }),
  components: { securitySchemes: schemes },
})

describe('credentialsFromSpec', () => {
  it('puts schemes a requirement lists together in one profile (Plaid)', () => {
    const api = doc(
      {
        clientId: header('PLAID-CLIENT-ID'),
        secret: header('PLAID-SECRET'),
        plaidVersion: header('Plaid-Version'),
        oauth2: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 't', scopes: {} } } },
      },
      [{ clientId: [], secret: [], plaidVersion: [] }],
      {
        '/accounts/get': {
          post: { security: [{ clientId: [], secret: [], plaidVersion: [] }, { oauth2: [] }] },
        },
        '/item/get': { post: {} },
      },
    )
    expect(credentialsFromSpec(api, 'plaid')).toEqual({
      profile: {
        name: 'plaid',
        title: 'API keys',
        apply: {
          headers: {
            'PLAID-CLIENT-ID': '{{secrets.PLAID_CLIENT_ID}}',
            'PLAID-SECRET': '{{secrets.PLAID_SECRET}}',
            'Plaid-Version': '{{secrets.PLAID_VERSION}}',
          },
        },
        schemes: ['clientId', 'secret', 'plaidVersion'],
      },
      secrets: ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_VERSION'],
      notes: [
        'Plaid-Version reads like a version, not a credential: put its value in PLAID_VERSION',
        'also accepted: oauth2 (not set up)',
      ],
    })
  })

  it('chooses bearer over basic when the spec accepts either (Stripe)', () => {
    const api = doc(
      {
        basicAuth: { type: 'http', scheme: 'basic' },
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'auth-scheme' },
      },
      [{ basicAuth: [] }, { bearerAuth: [] }],
      { '/v1/charges': { get: {} } },
    )
    expect(credentialsFromSpec(api, 'stripe')).toEqual({
      profile: {
        name: 'stripe',
        title: 'bearer token',
        apply: { headers: { authorization: 'Bearer {{secrets.STRIPE_BEARER_AUTH}}' } },
        schemes: ['bearerAuth'],
      },
      secrets: ['STRIPE_BEARER_AUTH'],
      notes: ['also accepted: basicAuth (not set up)'],
    })
  })

  it('uses the API key for Petstore and says what the other operations take', () => {
    expect(credentialsFromSpec(petstore, 'petstore')).toEqual({
      profile: {
        name: 'petstore',
        title: 'API key',
        apply: { headers: { api_key: '{{secrets.PETSTORE_API_KEY}}' } },
        schemes: ['api_key'],
      },
      secrets: ['PETSTORE_API_KEY'],
      notes: ['7 operations take only petstore_auth, which is not set up'],
    })
  })

  it('reads a Swagger 2 document the same way', () => {
    const r = credentialsFromSpec(petstore2, 'petstore')
    expect(r.secrets).toEqual(['PETSTORE_API_KEY'])
    expect(r.profile?.apply).toEqual({ headers: { api_key: '{{secrets.PETSTORE_API_KEY}}' } })
  })

  it('gives services added from the same spec secrets of their own', () => {
    expect(credentialsFromSpec(petstore, 'pets2').secrets).toEqual(['PETS2_API_KEY'])
    expect(credentialsFromSpec(petstore, 'multi').secrets).toEqual(['MULTI_API_KEY'])
  })

  it('writes a query key, and basic auth with a note about the encoding (Swagger 2)', () => {
    const query = {
      securityDefinitions: { key: { type: 'apiKey', in: 'query', name: 'api_key' } },
      security: [{ key: [] }],
    }
    expect(credentialsFromSpec(query, 'legacy')).toMatchObject({
      profile: { title: 'API key', apply: { query: { api_key: '{{secrets.LEGACY_KEY}}' } } },
      secrets: ['LEGACY_KEY'],
      notes: [],
    })
    const basic = { securityDefinitions: { basic: { type: 'basic' } }, security: [{ basic: [] }] }
    expect(credentialsFromSpec(basic, 'legacy')).toMatchObject({
      profile: {
        title: 'basic auth',
        apply: { headers: { authorization: 'Basic {{secrets.LEGACY_BASIC}}' } },
      },
      notes: ['LEGACY_BASIC is the base64 of user:password'],
    })
  })

  it('joins two cookies into one header', () => {
    const api = doc(
      {
        a: { type: 'apiKey', in: 'cookie', name: 'x' },
        b: { type: 'apiKey', in: 'cookie', name: 'y' },
      },
      [{ a: [], b: [] }],
    )
    expect(credentialsFromSpec(api, 'site').profile?.apply).toEqual({
      headers: { cookie: 'x={{secrets.SITE_A}}; y={{secrets.SITE_B}}' },
    })
  })

  it('titles a profile by what it sends', () => {
    const mixed = doc({ k: header('X-Key'), t: { type: 'http', scheme: 'bearer' } }, [
      { k: [], t: [] },
    ])
    expect(credentialsFromSpec(mixed, 's').profile?.title).toBe('credentials')
    const one = doc({ k: header('X-Key') }, [{ k: [] }])
    expect(credentialsFromSpec(one, 's').profile?.title).toBe('API key')
  })

  it('gives an OAuth scheme a pasted-token profile and says sign-in is not written', () => {
    const api = doc(
      {
        sso: {
          type: 'oauth2',
          flows: { authorizationCode: { authorizationUrl: 'a', tokenUrl: 't', scopes: {} } },
        },
      },
      [{ sso: [] }],
    )
    const r = credentialsFromSpec(api, 'acme')
    expect(r.profile?.apply).toEqual({ headers: { authorization: 'Bearer {{secrets.ACME_SSO}}' } })
    expect(r.profile?.title).toBe('OAuth token')
    expect(r.notes[0]).toContain('ACME_SSO takes an access token')
  })

  it('writes nothing for a scheme that cannot be a header or a query value', () => {
    const r = credentialsFromSpec(doc({ mtls: { type: 'mutualTLS' } }, [{ mtls: [] }]), 'x')
    expect(r.profile).toBeUndefined()
    expect(r.secrets).toEqual([])
    expect(r.notes).toEqual(['mtls cannot be sent as a header or a query value'])
  })

  it('says when two schemes would set the same header', () => {
    const api = doc(
      { b: { type: 'http', scheme: 'bearer' }, c: { type: 'http', scheme: 'basic' } },
      [{ b: [], c: [] }],
    )
    const r = credentialsFromSpec(api, 'x')
    expect(r.profile).toBeUndefined()
    expect(r.notes).toEqual(['b and c would set the same header, so they are not written'])
  })

  it('ignores an optional-auth entry and a document that secures nothing', () => {
    const k = { k: header('X-Key') }
    expect(credentialsFromSpec(doc(k, [{}, { k: [] }]), 's').secrets).toEqual(['S_K'])
    expect(credentialsFromSpec(doc(k, []), 's')).toEqual({ secrets: [], notes: [] })
    expect(credentialsFromSpec(doc(k), 's')).toEqual({ secrets: [], notes: [] })
    expect(credentialsFromSpec({ paths: {} }, 's')).toEqual({ secrets: [], notes: [] })
  })

  it('says when a requirement names a scheme the document does not define', () => {
    const r = credentialsFromSpec(doc({ k: header('X-Key') }, [{ ghost: [] }]), 's')
    expect(r.profile).toBeUndefined()
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
    expect(credentialsFromSpec(local, 's').profile?.apply).toEqual({
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
