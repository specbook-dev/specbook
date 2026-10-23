import { defineConfig } from '@specbook/core'

export default defineConfig({
  project: 'my-apis',
  // defaults for every environment; an environment overrides them in .specbook/environments/<env>.env
  vars: {
    plaidUrl: 'https://sandbox.plaid.com',
    // petstoreUrl: 'https://petstore3.swagger.io/api/v3',
  },
  // values come from environment variables of the same name or a gitignored <env>.secrets.env
  secrets: {
    PLAID_CLIENT_ID: {},
    PLAID_SECRET: {},
    PLAID_VERSION: {},
    PLAID_OAUTH2: {},
    PLAID_OAUTH2_CLIENT_ID: {},
    PLAID_OAUTH2_CLIENT_SECRET: {},
  },
  auth: {
    plaid: {
      // from the spec's security: clientId, secret, plaidVersion
      title: 'API keys',
      scheme: ['clientId', 'secret', 'plaidVersion'],
      apply: {
        headers: {
          'PLAID-CLIENT-ID': '{{secrets.PLAID_CLIENT_ID}}',
          'PLAID-SECRET': '{{secrets.PLAID_SECRET}}',
          'Plaid-Version': '{{secrets.PLAID_VERSION}}',
        },
      },
    },
    'plaid-oauth2': {
      // from the spec's security: oauth2
      title: 'OAuth token',
      scheme: 'oauth2',
      apply: { headers: { authorization: 'Bearer {{secrets.PLAID_OAUTH2}}' } },
    },
    'plaid-oauth2-client': {
      // from the spec's security: oauth2
      title: 'OAuth client credentials',
      scheme: 'oauth2',
      apply: { headers: { authorization: 'Bearer {{session.accessToken}}' } },
      oauth: {
        tokenUrl: 'https://api.plaid.com/oauth2/apiv2/token',
        clientId: '{{secrets.PLAID_OAUTH2_CLIENT_ID}}',
        clientSecret: '{{secrets.PLAID_OAUTH2_CLIENT_SECRET}}',
      },
    },
  },
  services: {
    plaid: {
      spec: './openapi/plaid.yml',
      baseUrl: '{{plaidUrl}}',
      auth: ['plaid', 'plaid-oauth2', 'plaid-oauth2-client'],
    },
    // petstore: { spec: './openapi/petstore.json', baseUrl: '{{petstoreUrl}}' },
  },
})
