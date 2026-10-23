import type { Keycloak } from './provision'

/**
 * Two small documents whose only operation is Keycloak's own `userinfo` endpoint: it accepts a bearer token and
 * answers 200, so the provider is also the protected API and no second server is needed.
 *
 * Titles and operation ids decide the keys the UI uses (`keycloak-oauth/GetUserinfo`).
 */
export const OAUTH_KEY = 'keycloak-oauth/GetUserinfo'
export const OIDC_KEY = 'keycloak-sso/GetUserinfo'
export const IMPLICIT_KEY = 'keycloak-implicit/GetUserinfo'
/** the secret names the schemes `kc` and `sso` become */
export const OAUTH_SECRET = 'KC'
export const OIDC_SECRET = 'SSO'
export const IMPLICIT_SECRET = 'IMP'

const userinfo = {
  '/protocol/openid-connect/userinfo': {
    get: {
      operationId: 'getUserinfo',
      summary: 'Who am I',
      responses: {
        '200': {
          description: 'ok',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      },
    },
  },
}

export function keycloakSpecs(kc: Keycloak) {
  const base = `${kc.url}/realms/${kc.realm}`
  const common = { openapi: '3.0.3', servers: [{ url: base }], paths: userinfo }
  return {
    oauth: {
      ...common,
      info: { title: 'Keycloak OAuth', version: '1' },
      security: [{ kc: [] }],
      components: {
        securitySchemes: {
          kc: {
            type: 'oauth2',
            flows: {
              authorizationCode: {
                authorizationUrl: `${base}/protocol/openid-connect/auth`,
                tokenUrl: `${base}/protocol/openid-connect/token`,
                scopes: { openid: 'OpenID Connect' },
              },
            },
          },
        },
      },
    },
    implicit: {
      ...common,
      info: { title: 'Keycloak Implicit', version: '1' },
      security: [{ imp: [] }],
      components: {
        securitySchemes: {
          imp: {
            type: 'oauth2',
            flows: {
              implicit: {
                authorizationUrl: `${base}/protocol/openid-connect/auth`,
                scopes: { openid: 'OpenID Connect' },
              },
            },
          },
        },
      },
    },
    oidc: {
      ...common,
      info: { title: 'Keycloak SSO', version: '1' },
      security: [{ sso: [] }],
      components: {
        securitySchemes: {
          sso: {
            type: 'openIdConnect',
            openIdConnectUrl: `${base}/.well-known/openid-configuration`,
          },
        },
      },
    },
  }
}
