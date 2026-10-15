import { defineConfig } from '@specbook/core'

export default defineConfig({
  project: 'petstore-example',
  vars: {
    defaultStatus: 'available',
    // GitHub sandbox repository; override with --var owner=... --var repo=...
    owner: 'your-username',
    repo: 'specbook-sandbox',
  },
  // How the docs site presents itself; `.specbook/branding/logo.svg` is picked up automatically.
  branding: {
    name: 'Specbook',
    title: 'API docs you can actually run',
    tagline:
      'Try Stripe, GitHub, Petstore and GraphQL here with mock data, then point the same requests and flows at the real APIs.',
    accent: '#6d28d9',
    accentDark: '#a78bfa',
    links: [
      { label: 'Stripe API reference', href: 'https://docs.stripe.com/api' },
      { label: 'GitHub REST docs', href: 'https://docs.github.com/rest' },
    ],
  },
  faker: { locales: { en: ['en'], de: ['de', 'en'], ja: ['ja', 'en'] }, default: 'en' },
  secrets: { PETSTORE_API_KEY: {}, STRIPE_API_KEY: {}, GITHUB_TOKEN: {} },
  services: {
    petstore: {
      spec: './openapi/petstore.json',
      baseUrl: { live: 'https://petstore3.swagger.io/api/v3' },
      auth: 'apiKey',
    },
    stripe: {
      spec: './openapi/stripe.json',
      baseUrl: { live: 'https://api.stripe.com' },
      auth: 'stripe',
    },
    countries: {
      spec: './openapi/countries.json',
      baseUrl: { live: 'https://countries.trevorblades.com' },
    },
    github: {
      spec: './openapi/github.json',
      baseUrl: { live: 'https://api.github.com' },
      auth: 'github',
    },
  },
  auth: {
    // Static-token profile: no login, the secret is applied to every secured request.
    apiKey: {
      title: 'Petstore API key',
      apply: { headers: { api_key: '{{secrets.PETSTORE_API_KEY}}' } },
    },
    // Test-mode secret key (sk_test_...). Never use a live key.
    stripe: {
      title: 'Stripe test key',
      apply: { headers: { authorization: 'Bearer {{secrets.STRIPE_API_KEY}}' } },
    },
    // Fine-grained PAT scoped to a sandbox repository.
    github: {
      title: 'GitHub PAT',
      apply: {
        headers: {
          authorization: 'Bearer {{secrets.GITHUB_TOKEN}}',
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      },
    },
  },
})
