import { c, type InferControls, script, withMock } from '@specbook/core'

// Cloudflare publishes test keys for trying Turnstile: no account, any hostname. A page that uses one gets a token that only
// Cloudflare's test secret accepts, so nothing here can protect anything: it shows how a widget fits in a flow.
export const KEYS = [
  { key: '1x00000000000000000000AA', label: 'Always passes' },
  { key: '3x00000000000000000000FF', label: 'Asks for a click first' },
] as const

// #region contract
export const inputs = {
  siteKey: c.select(KEYS, {
    label: (k) => k.label,
    value: (k) => k.key as string,
    default: 0,
    description: 'One of Cloudflare’s test keys.',
  }),
}
export type Inputs = InferControls<typeof inputs>

export default withMock(
  script({
    id: 'turnstile',
    name: 'Prove you are human',
    description: 'Shows Cloudflare’s Turnstile widget in the step and returns the token it gives.',
    runtime: 'browser',
    tags: ['captcha'],
    inputs,
    // the widget's code is its own file, fetched when the step runs
    load: () => import('./turnstile.browser'),
    assert: (out, { assert }) => assert.ok(out.token, 'a token came back'),
  }),
  // the mock answers with a dummy token, for the key it was asked for
  ({ inputs }) => ({ token: 'XXXX.DUMMY.TOKEN.XXXX', siteKey: inputs.siteKey }),
)
// #endregion contract
