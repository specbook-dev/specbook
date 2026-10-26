import { defineConfig } from '@specbook/core'

export default defineConfig({
  project: 'petstore-example',
  vars: {
    // where each API lives: the defaults, which an environment overrides in .specbook/environments/<env>.env
    petstoreUrl: 'https://petstore3.swagger.io/api/v3',
    stripeUrl: 'https://api.stripe.com',
    countriesUrl: 'https://countries.trevorblades.com',
    githubUrl: 'https://api.github.com',
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
  secrets: { PETSTORE_API_KEY: {}, PETSTORE_AUTH: {}, STRIPE_API_KEY: {}, GITHUB_TOKEN: {} },
  services: {
    petstore: {
      spec: './openapi/petstore.json',
      baseUrl: '{{petstoreUrl}}',
      // the ways the spec accepts, the default first: an operation uses the first one it accepts
      auth: ['petstore', 'petstore-auth'],
    },
    stripe: {
      spec: './openapi/stripe.json',
      baseUrl: '{{stripeUrl}}',
      auth: 'stripe',
      // the spec's descriptions link to pages by path (`/api/accounts`): this is where they go
      docsUrl: 'https://docs.stripe.com',
    },
    countries: {
      spec: './openapi/countries.json',
      baseUrl: '{{countriesUrl}}',
    },
    github: {
      spec: './openapi/github.json',
      baseUrl: '{{githubUrl}}',
      docsUrl: 'https://docs.github.com',
      auth: 'github',
    },
  },
  auth: {
    // #region petstore-auth
    // Static-token profile: no login, the secret is applied to every request that accepts it.
    petstore: {
      title: 'API key',
      scheme: 'api_key',
      apply: { headers: { api_key: '{{secrets.PETSTORE_API_KEY}}' } },
    },
    // The other way the spec accepts: sign in (the implicit flow of the public Petstore), or paste a token.
    'petstore-auth': {
      title: 'OAuth sign-in',
      scheme: 'petstore_auth',
      apply: { headers: { authorization: 'Bearer {{secrets.PETSTORE_AUTH}}' } },
      oauth: {
        flow: 'implicit',
        authorizationUrl: 'https://petstore3.swagger.io/oauth/authorize',
        scopes: {
          'write:pets': 'modify pets in your account',
          'read:pets': 'read your pets',
        },
      },
    },
    // #endregion petstore-auth
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
