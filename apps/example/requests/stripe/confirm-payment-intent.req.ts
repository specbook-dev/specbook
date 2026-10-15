import { PostPaymentIntentsIntentConfirm } from '#api/stripe'

export default PostPaymentIntentsIntentConfirm.request({
  name: 'Confirm a payment intent',
  init: { intentId: 'pi_mock_123', paymentMethod: 'pm_card_visa' },
  path: { intent: '{{intentId}}' },
  data: { payment_method: '{{paymentMethod}}', return_url: 'https://example.com/return' },
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'confirmed')
    if (res.status === 200) assert.is(res.data.status, 'succeeded', 'payment succeeded')
  },
  mock: {
    // Stripe's test card for declines makes the mock answer like the real API (402).
    when: ({ vars }) => (vars.paymentMethod === 'pm_card_chargeDeclined' ? 402 : undefined),
    responses: {
      200: { id: '{{intentId}}', status: 'succeeded' },
      402: {
        error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' },
      },
    },
  },
})
