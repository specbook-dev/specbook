import { c, sequence } from '@specbook/core'
import verify from '../requests/turnstile/verify.req'
import turnstile, { KEYS } from '../scripts/turnstile.script'

// #region flow
export default sequence({
  id: 'human-check',
  title: 'Prove you are human',
  description:
    'Shows Cloudflare’s Turnstile widget, with a test key, then verifies the token it gives, the way a server does. The widget needs a browser, so the mock environment answers for it.',
  tags: ['captcha'],
  inputs: {
    siteKey: c.select(KEYS, {
      label: (k) => k.label,
      value: (k) => k.key as string,
      default: 0,
      description: 'One of Cloudflare’s test keys.',
    }),
  },
})
  .step('Pass the Turnstile check', turnstile.with({ inputs: { siteKey: '{{siteKey}}' } }))
  // a step given as it is tells the panel which APIs the flow calls, so it asks for those credentials and no others
  .step('Verify the token', verify.with({ data: { response: '{{token}}' } }))
  // #endregion flow
  .check('The token verified', (ctx, { assert }) => {
    assert.is(ctx.captured.verified, true, 'Cloudflare accepted it')
  })
