import { c, sequence } from '@specbook/core'
import placeOrder from '../requests/petstore/place-order.req'
import approve from '../scripts/approve.script'
import fingerprint from '../scripts/card-fingerprint.script'

// A flow with steps that are not requests: a script works out a fingerprint anywhere, and another asks a person to approve
// the payment, which needs a browser. On the mock every step answers; in `specbook test --env live` the flow is skipped.
export default sequence({
  id: 'approve-order',
  title: 'Order, then approve the payment',
  description:
    'Places an order, fingerprints the card and asks for the payment to be approved. The approval is a script that needs a browser.',
  tags: ['petstore', 'scripts'],
  inputs: {
    cardNumber: c.text({
      default: '4242424242424242',
      description: 'Only its fingerprint is kept.',
    }),
  },
})
  // #region flow
  .step('Place order', placeOrder)
  .step('Fingerprint the card', fingerprint.with({ inputs: { cardNumber: '{{cardNumber}}' } }))
  .step('Approve the payment', approve.with({ inputs: { amount: 25, currency: 'USD' } }))
  .check('The card is fingerprinted and the payment approved', (ctx, { assert }) => {
    assert.is(ctx.captured.fingerprint.length, 64, 'a SHA-256 fingerprint')
    assert.is(ctx.captured.last4, ctx.inputs.cardNumber.slice(-4), 'the last four digits')
    assert.ok(ctx.captured.approvedAt, 'approved')
    assert.is(ctx.captured.amount, 25, 'the amount approved')
  })
// #endregion flow
