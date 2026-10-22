import { describe, expect, it } from 'vitest'
import petstore from '../../../apps/example/openapi/petstore.json'
import petstore2 from '../../codegen/test/fixtures/petstore2.json'
import { authFromSpec } from '../src'

// what the viewer and `specbook preview` build from a document: this must not change when the mapping is shared

// Stripe's security section as its spec declares it (the document itself is 8 MB)
const stripe = {
  security: [{ basicAuth: [] }, { bearerAuth: [] }],
  components: {
    securitySchemes: {
      basicAuth: { type: 'http', scheme: 'basic' },
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'auth-scheme' },
    },
  },
}

describe('authFromSpec output is unchanged', () => {
  it('petstore 3', () => {
    expect(authFromSpec(petstore)).toMatchInlineSnapshot(`
      {
        "auth": {
          "api_key": {
            "apply": {
              "headers": {
                "api_key": "{{secrets.API_KEY}}",
              },
            },
            "title": "api_key (API key, header "api_key")",
          },
          "petstore_auth": {
            "apply": {
              "headers": {
                "authorization": "Bearer {{secrets.PETSTORE_AUTH}}",
              },
            },
            "title": "petstore_auth (OAuth, paste an access token)",
          },
        },
        "defaultProfile": "petstore_auth",
        "environmentVars": {},
        "secrets": {
          "API_KEY": {},
          "PETSTORE_AUTH": {},
        },
        "vars": {},
      }
    `)
  })

  it('petstore 2 (Swagger)', () => {
    expect(authFromSpec(petstore2)).toMatchInlineSnapshot(`
      {
        "auth": {
          "api_key": {
            "apply": {
              "headers": {
                "api_key": "{{secrets.API_KEY}}",
              },
            },
            "title": "api_key (API key, header "api_key")",
          },
          "petstore_auth": {
            "apply": {
              "headers": {
                "authorization": "Bearer {{secrets.PETSTORE_AUTH}}",
              },
            },
            "title": "petstore_auth (OAuth, paste an access token)",
          },
        },
        "defaultProfile": "api_key",
        "environmentVars": {},
        "secrets": {
          "API_KEY": {},
          "PETSTORE_AUTH": {},
        },
        "vars": {},
      }
    `)
  })

  it('stripe', () => {
    expect(authFromSpec(stripe)).toMatchInlineSnapshot(`
      {
        "auth": {
          "basicAuth": {
            "apply": {
              "headers": {
                "authorization": "Basic {{secrets.BASICAUTH}}",
              },
            },
            "title": "basicAuth (basic auth, paste base64 of user:password)",
          },
          "bearerAuth": {
            "apply": {
              "headers": {
                "authorization": "Bearer {{secrets.BEARERAUTH}}",
              },
            },
            "title": "bearerAuth (bearer token)",
          },
        },
        "defaultProfile": "basicAuth",
        "environmentVars": {},
        "secrets": {
          "BASICAUTH": {},
          "BEARERAUTH": {},
        },
        "vars": {},
      }
    `)
  })

  it('every scheme type, with a relative sign-in address and servers', () => {
    const api = {
      security: [{ bearer: [] }],
      components: {
        securitySchemes: {
          api_key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
          q: { type: 'apiKey', in: 'query', name: 'token' },
          jar: { type: 'apiKey', in: 'cookie', name: 'sid' },
          bearer: { type: 'http', scheme: 'bearer' },
          basic: { type: 'http', scheme: 'Basic' },
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
          oidc: {
            type: 'openIdConnect',
            openIdConnectUrl: 'https://id.example.test/.well-known/openid-configuration',
          },
          mtls: { type: 'mutualTLS' },
        },
      },
    }
    expect(
      authFromSpec(api, undefined, [
        { name: 'live', url: 'https://api.example.test/v1' },
        { name: 'sandbox', url: 'https://sandbox.example.test/v1' },
      ]),
    ).toMatchInlineSnapshot(`
      {
        "auth": {
          "api_key": {
            "apply": {
              "headers": {
                "X-Api-Key": "{{secrets.API_KEY}}",
              },
            },
            "title": "api_key (API key, header "X-Api-Key")",
          },
          "basic": {
            "apply": {
              "headers": {
                "authorization": "Basic {{secrets.BASIC}}",
              },
            },
            "title": "basic (basic auth, paste base64 of user:password)",
          },
          "bearer": {
            "apply": {
              "headers": {
                "authorization": "Bearer {{secrets.BEARER}}",
              },
            },
            "title": "bearer (bearer token)",
          },
          "jar": {
            "apply": {
              "headers": {
                "cookie": "sid={{secrets.JAR}}",
              },
            },
            "title": "jar (API key, cookie "sid")",
          },
          "oidc": {
            "apply": {
              "headers": {
                "authorization": "Bearer {{secrets.OIDC}}",
              },
            },
            "oauth": {
              "openIdConnectUrl": "https://id.example.test/.well-known/openid-configuration",
            },
            "title": "oidc (OAuth, sign in or paste an access token)",
          },
          "q": {
            "apply": {
              "query": {
                "token": "{{secrets.Q}}",
              },
            },
            "title": "q (API key, query "token")",
          },
          "sso": {
            "apply": {
              "headers": {
                "authorization": "Bearer {{secrets.SSO}}",
              },
            },
            "oauth": {
              "authorizationUrl": "{{ssoAuthorizationUrl}}",
              "scopes": {
                "read": "Read",
              },
              "tokenUrl": "{{ssoTokenUrl}}",
            },
            "title": "sso (OAuth, sign in or paste an access token)",
          },
        },
        "defaultProfile": "bearer",
        "environmentVars": {
          "sandbox": {
            "ssoAuthorizationUrl": "https://sandbox.example.test/v1/auth",
            "ssoTokenUrl": "https://sandbox.example.test/v1/token",
          },
        },
        "secrets": {
          "API_KEY": {},
          "BASIC": {},
          "BEARER": {},
          "JAR": {},
          "OIDC": {},
          "Q": {},
          "SSO": {},
        },
        "vars": {
          "ssoAuthorizationUrl": "https://api.example.test/v1/auth",
          "ssoTokenUrl": "https://api.example.test/v1/token",
        },
      }
    `)
  })

  it('a Plaid-shaped document: schemes that must all apply stay separate profiles today', () => {
    const header = (name: string) => ({ type: 'apiKey', in: 'header', name })
    const api = {
      security: [{ clientId: [], secret: [], plaidVersion: [] }],
      components: {
        securitySchemes: {
          clientId: header('PLAID-CLIENT-ID'),
          secret: header('PLAID-SECRET'),
          plaidVersion: header('Plaid-Version'),
        },
      },
    }
    expect(authFromSpec(api)).toMatchInlineSnapshot(`
      {
        "auth": {
          "clientId": {
            "apply": {
              "headers": {
                "PLAID-CLIENT-ID": "{{secrets.CLIENTID}}",
              },
            },
            "title": "clientId (API key, header "PLAID-CLIENT-ID")",
          },
          "plaidVersion": {
            "apply": {
              "headers": {
                "Plaid-Version": "{{secrets.PLAIDVERSION}}",
              },
            },
            "title": "plaidVersion (API key, header "Plaid-Version")",
          },
          "secret": {
            "apply": {
              "headers": {
                "PLAID-SECRET": "{{secrets.SECRET}}",
              },
            },
            "title": "secret (API key, header "PLAID-SECRET")",
          },
        },
        "defaultProfile": "clientId",
        "environmentVars": {},
        "secrets": {
          "CLIENTID": {},
          "PLAIDVERSION": {},
          "SECRET": {},
        },
        "vars": {},
      }
    `)
  })
})
