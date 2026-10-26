import { c, script, withMock } from '@specbook/core'

// #region isomorphic
// Works anywhere: WebCrypto is in every browser and in node, so the same step runs in the portal, in `specbook test` and
// in the bundle. Its body is small, so it stays in this file.
export default withMock(
  script({
    id: 'card-fingerprint',
    name: 'Fingerprint a card',
    description: 'A SHA-256 of the card number, so a flow can compare cards without keeping one.',
    runtime: 'isomorphic',
    inputs: { cardNumber: c.text({ description: 'Digits only.' }) },
    run: async ({ cardNumber }) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cardNumber))
      const fingerprint = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      return { fingerprint, last4: cardNumber.slice(-4) }
    },
  }),
  // SHA-256 of nothing: any 64 hex digits will do for the mock
  ({ inputs }) => ({
    fingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    last4: inputs.cardNumber.slice(-4),
  }),
)
// #endregion isomorphic
