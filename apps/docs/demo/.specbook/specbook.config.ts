import { defineConfig } from '@specbook/core'

export default defineConfig({
  project: 'specbook-docs-demo',
  vars: {
    // where each API lives by default: the real ones; the `demo` environment points them at this site's own demo API
    petstoreUrl: 'https://petstore3.swagger.io/api/v3',
    countriesUrl: 'https://countries.trevorblades.com',
  },
  faker: { locales: { en: ['en'], de: ['de', 'en'], ja: ['ja', 'en'] }, default: 'en' },
  secrets: { PETSTORE_API_KEY: {} },
  services: {
    petstore: { spec: './openapi/petstore.json', baseUrl: '{{petstoreUrl}}', auth: 'apiKey' },
    countries: { spec: './openapi/countries.json', baseUrl: '{{countriesUrl}}' },
  },
  auth: {
    // The public Petstore documents this header and accepts any value. Its secured operations show it
    // wherever the environment is not mock.
    apiKey: {
      title: 'Petstore API key',
      apply: { headers: { api_key: '{{secrets.PETSTORE_API_KEY}}' } },
    },
  },
})
