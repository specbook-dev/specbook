import { defineConfig } from '@specbook/core'

export default defineConfig({
  project: 'my-apis',
  // defaults for every environment; an environment overrides them in .specbook/environments/<env>.env
  vars: {
    plaidUrl: 'https://sandbox.plaid.com',
    // petstoreUrl: 'https://petstore3.swagger.io/api/v3',
  },
  // values come from environment variables of the same name or a gitignored <env>.secrets.env
  secrets: { PLAID_CLIENT_ID: {}, PLAID_SECRET: {}, PLAID_VERSION: {} },
  auth: {
    plaid: {
      // from the spec's security: clientId, secret, plaidVersion
      title: 'API keys',
      apply: {
        headers: {
          'PLAID-CLIENT-ID': '{{secrets.PLAID_CLIENT_ID}}',
          'PLAID-SECRET': '{{secrets.PLAID_SECRET}}',
          'Plaid-Version': '{{secrets.PLAID_VERSION}}',
        },
      },
    },
  },
  services: {
    plaid: {
      spec: './openapi/plaid.yml',
      baseUrl: '{{plaidUrl}}',
      auth: 'plaid',
    },
    // petstore: { spec: './openapi/petstore.json', baseUrl: '{{petstoreUrl}}' },
  },
})
