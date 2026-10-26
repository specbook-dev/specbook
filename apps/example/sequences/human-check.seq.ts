import { c, sequence } from '@specbook/core'
import turnstile, { KEYS } from '../scripts/turnstile.script'

// A flow that is one script: Cloudflare's Turnstile widget with a dummy test key. It needs a browser, so on a real
// environment `specbook test` skips it; on the mock the contract answers.
export default sequence({
  id: 'human-check',
  title: 'Prove you are human',
  description:
    'Shows Cloudflare’s Turnstile widget, with a dummy test key, and checks that a token comes back. Switch the environment to live to see the widget.',
  tags: ['scripts'],
  inputs: {
    siteKey: c.select(KEYS, {
      label: (k) => k.label,
      value: (k) => k.key as string,
      default: 0,
      description: 'One of Cloudflare’s dummy test keys.',
    }),
  },
})
  .step('Pass the Turnstile check', turnstile.with({ inputs: { siteKey: '{{siteKey}}' } }))
  .check('A token came back', (ctx, { assert }) => {
    assert.ok(ctx.captured.token.length > 0, 'a token')
  })
