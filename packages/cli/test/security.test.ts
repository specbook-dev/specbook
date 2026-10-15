import { describe, expect, it } from 'vitest'
import { authFromSpec } from '../src/security'

describe('authFromSpec', () => {
  it('maps header, query, bearer and oauth schemes to secret placeholders', () => {
    const r = authFromSpec({
      security: [{ bearer: [] }],
      components: {
        securitySchemes: {
          api_key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
          q: { type: 'apiKey', in: 'query', name: 'token' },
          bearer: { type: 'http', scheme: 'bearer' },
          oauth: { type: 'oauth2', flows: {} },
          mtls: { type: 'mutualTLS' },
        },
      },
    })
    expect(r.auth.api_key?.apply).toEqual({ headers: { 'X-Api-Key': '{{secrets.API_KEY}}' } })
    expect(r.auth.q?.apply).toEqual({ query: { token: '{{secrets.Q}}' } })
    expect(r.auth.bearer?.apply.headers?.authorization).toBe('Bearer {{secrets.BEARER}}')
    expect(r.auth.oauth?.apply.headers?.authorization).toBe('Bearer {{secrets.OAUTH}}')
    expect(r.auth.mtls).toBeUndefined()
    expect(Object.keys(r.secrets).sort()).toEqual(['API_KEY', 'BEARER', 'OAUTH', 'Q'])
    expect(r.defaultProfile).toBe('bearer')
  })

  it('reads Swagger 2 securityDefinitions and falls back to the first scheme', () => {
    const r = authFromSpec({
      securityDefinitions: { key: { type: 'apiKey', in: 'header', name: 'api_key' } },
    })
    expect(r.defaultProfile).toBe('key')
    expect(r.secrets).toEqual({ KEY: {} })
  })

  it('has no profiles for an open API', () => {
    expect(authFromSpec({ paths: {} })).toEqual({
      auth: {},
      secrets: {},
      defaultProfile: undefined,
    })
  })
})
