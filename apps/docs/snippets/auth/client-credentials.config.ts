import { defineConfig } from '@specbook/core'

export default defineConfig({
  project: 'acme',
  vars: {
    acmeUrl: 'https://api.acme.example/v1',
    issuer: 'https://id.acme.example/realms/acme',
  },
  secrets: { ACME_CLIENT_ID: {}, ACME_CLIENT_SECRET: {}, ACME_TOKEN: {} },
  auth: {
    // #region client-credentials
    'acme-service': {
      title: 'Service account',
      scheme: 'oauth',
      // the token the run fetched, as `{{session.accessToken}}`
      apply: { headers: { authorization: 'Bearer {{session.accessToken}}' } },
      oauth: {
        tokenUrl: '{{issuer}}/protocol/openid-connect/token',
        clientId: '{{secrets.ACME_CLIENT_ID}}',
        clientSecret: '{{secrets.ACME_CLIENT_SECRET}}',
      },
    },
    // #endregion client-credentials
    // a token someone issued, for the page that has no server
    'acme-token': {
      title: 'Access token',
      scheme: 'oauth',
      apply: { headers: { authorization: 'Bearer {{secrets.ACME_TOKEN}}' } },
    },
  },
  services: {
    acme: {
      spec: './openapi/acme.yml',
      baseUrl: '{{acmeUrl}}',
      auth: ['acme-service', 'acme-token'],
    },
  },
})
