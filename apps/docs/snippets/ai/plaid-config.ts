import { defineConfig } from '@specbook/core'

export default defineConfig({
  project: 'my-apis',
  // defaults for every environment; an environment overrides them in .specbook/environments/<env>.env
  vars: {
    plaidUrl: 'https://sandbox.plaid.com',
    // petstoreUrl: 'https://petstore3.swagger.io/api/v3',
  },
  // values come from environment variables of the same name or a gitignored <env>.secrets.env
  secrets: { PLAID_CLIENT_ID: {}, PLAID_SECRET: {} },
  auth: {
    // the spec's global security: the clientId, secret and plaidVersion header schemes
    plaid: {
      apply: {
        headers: {
          'PLAID-CLIENT-ID': '{{secrets.PLAID_CLIENT_ID}}',
          'PLAID-SECRET': '{{secrets.PLAID_SECRET}}',
          'Plaid-Version': '2020-09-14',
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
