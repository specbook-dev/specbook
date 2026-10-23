import type { SecurityRequirement } from '@specbook/core'
import { describe, expect, it } from 'vitest'
import {
  describeScheme,
  describeSecurity,
  lockTitle,
  requiredScopes,
  type SchemeInfo,
} from '../src/auth-describe'

const schemes: Record<string, SchemeInfo> = {
  api_key: { type: 'apiKey', in: 'header', name: 'api_key' },
  petstore_auth: {
    type: 'oauth2',
    flows: { implicit: { scopes: ['write:pets', 'read:pets'] } },
  },
  bearer: { type: 'http', scheme: 'bearer' },
  basic: { type: 'http', scheme: 'Basic' },
  oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://id.test' },
  multi: {
    type: 'oauth2',
    flows: { authorizationCode: { scopes: [] }, clientCredentials: { scopes: [] } },
  },
}

describe('describeScheme', () => {
  it('says how each kind of scheme is sent', () => {
    expect(describeScheme(schemes.api_key)).toBe('API key in header "api_key"')
    expect(describeScheme(schemes.petstore_auth)).toBe('OAuth 2.0 (implicit)')
    expect(describeScheme(schemes.multi)).toBe('OAuth 2.0 (authorization code, client credentials)')
    expect(describeScheme(schemes.bearer)).toBe('bearer token')
    expect(describeScheme(schemes.basic)).toBe('basic auth')
    expect(describeScheme(schemes.oidc)).toBe('OpenID Connect')
    expect(describeScheme({ type: 'mutualTLS' })).toBe('mutual TLS')
    expect(describeScheme(undefined)).toContain('does not define')
  })
})

describe('describeSecurity and lockTitle', () => {
  const either: SecurityRequirement[] = [
    { api_key: [] },
    { petstore_auth: ['write:pets', 'read:pets'] },
  ]

  it('lists the alternatives, each as the schemes that apply together, with scopes', () => {
    expect(describeSecurity(either, schemes)).toEqual([
      [{ scheme: 'api_key', how: 'API key in header "api_key"', scopes: [] }],
      [
        {
          scheme: 'petstore_auth',
          how: 'OAuth 2.0 (implicit)',
          scopes: ['write:pets', 'read:pets'],
        },
      ],
    ])
    expect(describeSecurity([{ api_key: [], bearer: [] }], schemes)[0]).toHaveLength(2)
    expect(describeSecurity([{}], schemes)).toEqual([])
    expect(describeSecurity(undefined, schemes)).toEqual([])
  })

  it('writes one line for a tooltip, shortening a long scope list', () => {
    expect(lockTitle(either, schemes)).toBe(
      'Needs credentials: api_key or petstore_auth (write:pets, read:pets)',
    )
    expect(lockTitle([{ api_key: [], bearer: [] }], schemes)).toBe(
      'Needs credentials: api_key + bearer',
    )
    expect(lockTitle([{ s: ['a', 'b', 'c', 'd'] }], schemes)).toBe(
      'Needs credentials: s (a, b, c, …)',
    )
    expect(lockTitle(undefined, schemes)).toBe('Needs credentials')
  })
})

describe('requiredScopes', () => {
  it('collects the scopes the operations want of a profile’s schemes, once each', () => {
    const sec: (boolean | SecurityRequirement[] | undefined)[] = [
      [{ api_key: [] }, { petstore_auth: ['write:pets', 'read:pets'] }],
      [{ petstore_auth: ['read:pets', 'delete:pets'] }],
      true,
      undefined,
    ]
    expect(requiredScopes(sec, ['petstore_auth'])).toEqual([
      'write:pets',
      'read:pets',
      'delete:pets',
    ])
    expect(requiredScopes(sec, ['api_key'])).toEqual([])
    expect(requiredScopes(sec, [])).toEqual([])
  })
})
