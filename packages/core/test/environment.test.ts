import { describe, expect, it } from 'vitest'
import {
  AddressError,
  addressUses,
  authFromSpec,
  baseUrlFor,
  environmentNames,
  environmentScope,
  environmentsFromServers,
  isAbsoluteHttp,
  oauthFor,
  openApiServers,
} from '../src'

const cfg = {
  vars: { petstoreUrl: 'https://petstore.test/v3', page: 20 },
  environments: { staging: { vars: { page: 50 } }, sandbox: {} },
  services: {
    petstore: { spec: '', baseUrl: '{{petstoreUrl}}/' },
    legacy: { spec: '', baseUrl: { live: 'https://legacy.test', eu: 'https://eu.legacy.test' } },
  },
}

describe('environmentScope', () => {
  it('layers config vars, environment vars and the environment file', () => {
    expect(environmentScope(cfg, 'staging', { petstoreUrl: 'https://staging.test' })).toEqual({
      petstoreUrl: 'https://staging.test',
      page: 50,
    })
    expect(environmentScope(cfg, 'live')).toEqual({
      petstoreUrl: 'https://petstore.test/v3',
      page: 20,
    })
  })
})

describe('baseUrlFor', () => {
  const scope = environmentScope(cfg, 'live')
  it('renders a string template and drops the trailing slash', () => {
    expect(baseUrlFor(cfg, 'petstore', 'live', scope)).toBe('https://petstore.test/v3')
  })
  it('reads a record by environment name', () => {
    expect(baseUrlFor(cfg, 'legacy', 'eu', scope)).toBe('https://eu.legacy.test')
    expect(baseUrlFor(cfg, 'legacy', 'staging', scope)).toBeUndefined()
  })
  it('names the variable that is missing', () => {
    const err = (() => {
      try {
        baseUrlFor(cfg, 'petstore', 'staging', {})
      } catch (e) {
        return e as AddressError
      }
    })()
    expect(err).toBeInstanceOf(AddressError)
    expect(err?.message).toBe('No base URL for petstore in staging: set petstoreUrl')
    expect(err?.variable).toBe('petstoreUrl')
  })
  it('refuses secrets and faker values in an address', () => {
    const c = { services: { a: { spec: '', baseUrl: 'https://{{secrets.HOST}}' } } }
    expect(() => baseUrlFor(c, 'a', 'live', {})).toThrow(/secrets\.HOST/)
    const f = { services: { a: { spec: '', baseUrl: '{{faker.internet.url}}' } } }
    expect(() => baseUrlFor(f, 'a', 'live', {})).toThrow(AddressError)
  })
  it('treats an empty result as no address', () => {
    const c = { services: { a: { spec: '', baseUrl: '{{x}}' } } }
    expect(baseUrlFor(c, 'a', 'live', { x: '' })).toBeUndefined()
  })
  it('accepts a number-like value', () => {
    const c = { services: { a: { spec: '', baseUrl: 'http://localhost:{{port}}' } } }
    expect(baseUrlFor(c, 'a', 'live', { port: 8080 })).toBe('http://localhost:8080')
  })
})

describe('oauthFor', () => {
  it('renders the four address fields only', () => {
    const out = oauthFor(
      {
        authorizationUrl: '{{issuer}}/auth',
        tokenUrl: '{{issuer}}/token',
        clientId: '{{client}}',
        scopes: { 'read {{x}}': 'kept' },
      },
      { issuer: 'https://id.test', client: 'docs' },
    )
    expect(out).toEqual({
      authorizationUrl: 'https://id.test/auth',
      tokenUrl: 'https://id.test/token',
      clientId: 'docs',
      scopes: { 'read {{x}}': 'kept' },
    })
  })
  it('reports which sign-in field lacks a variable', () => {
    expect(() => oauthFor({ openIdConnectUrl: '{{issuer}}/x' }, {}, 'sso')).toThrow(
      'sso openIdConnectUrl: set issuer',
    )
  })
})

describe('environmentNames', () => {
  it('lists mock, live, record keys, environments, files and extras without repeats', () => {
    expect(environmentNames(cfg, ['staging', 'qa'], ['mine'])).toEqual([
      'mock',
      'live',
      'eu',
      'staging',
      'sandbox',
      'qa',
      'mine',
    ])
  })
  it('keeps a record-only config as it was', () => {
    const c = { services: { a: { spec: '', baseUrl: { live: 'x', staging: 'y' } } } }
    expect(environmentNames(c)).toEqual(['mock', 'live', 'staging'])
  })
})

describe('addressUses', () => {
  it('says which services and sign-in fields read a variable', () => {
    const uses = addressUses({
      ...cfg,
      auth: { sso: { oauth: { openIdConnectUrl: '{{issuer}}/.well-known', clientId: 'x' } } },
    })
    expect(uses.petstoreUrl).toEqual({ services: ['petstore'], profiles: [] })
    expect(uses.issuer).toEqual({
      services: [],
      profiles: [{ profile: 'sso', field: 'openIdConnectUrl' }],
    })
  })
})

describe('isAbsoluteHttp', () => {
  it('accepts http(s) addresses only', () => {
    expect(isAbsoluteHttp('https://a.test/x')).toBe(true)
    expect(isAbsoluteHttp('/api/v1')).toBe(false)
    expect(isAbsoluteHttp('ftp://a.test')).toBe(false)
  })
})

describe('importing servers', () => {
  const api = {
    servers: [
      { url: 'https://api.test/v3' },
      { url: 'https://staging.test/v3', description: 'Staging' },
    ],
    components: {
      securitySchemes: {
        sso: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: '/oauth/authorize',
              tokenUrl: 'oauth/token',
              scopes: {},
            },
          },
        },
        oidc: {
          type: 'openIdConnect',
          openIdConnectUrl: 'https://id.test/.well-known/openid-configuration',
        },
      },
    },
  }
  const { servers } = openApiServers(api, 'https://api.test/openapi.json')

  it('turns servers into a variable and per-environment values', () => {
    expect(environmentsFromServers(servers, 'baseUrl')).toEqual({
      vars: { baseUrl: 'https://api.test/v3' },
      environments: {
        staging: { description: 'Staging', vars: { baseUrl: 'https://staging.test/v3' } },
      },
      baseUrl: '{{baseUrl}}',
    })
  })

  it('writes a relative sign-in address as a variable that follows the server', () => {
    const out = authFromSpec(api, 'https://api.test/openapi.json', servers)
    expect(out.auth.sso?.oauth).toEqual({
      authorizationUrl: '{{ssoAuthorizationUrl}}',
      tokenUrl: '{{ssoTokenUrl}}',
    })
    // a leading slash is relative to the host, the other to the server's path
    expect(out.vars).toEqual({
      ssoAuthorizationUrl: 'https://api.test/oauth/authorize',
      ssoTokenUrl: 'https://api.test/v3/oauth/token',
    })
    expect(out.environmentVars.staging).toEqual({
      ssoAuthorizationUrl: 'https://staging.test/oauth/authorize',
      ssoTokenUrl: 'https://staging.test/v3/oauth/token',
    })
    expect(out.auth.oidc?.oauth).toEqual({
      openIdConnectUrl: 'https://id.test/.well-known/openid-configuration',
    })
  })

  it('without servers resolves against the document as before', () => {
    const out = authFromSpec(api, 'https://api.test/openapi.json')
    expect(out.auth.sso?.oauth).toMatchObject({ tokenUrl: 'https://api.test/oauth/token' })
    expect(out.vars).toEqual({})
  })
})

describe('oauthFor with secrets', () => {
  it('leaves a client id held as a secret for the server to fill, and renders the address', () => {
    const out = oauthFor(
      { tokenUrl: '{{issuer}}/token', clientId: '{{secrets.ID}}', clientSecret: '{{secrets.S}}' },
      { issuer: 'https://idp.example' },
    )
    expect(out).toEqual({
      tokenUrl: 'https://idp.example/token',
      clientId: '{{secrets.ID}}',
      clientSecret: '{{secrets.S}}',
    })
  })
})
