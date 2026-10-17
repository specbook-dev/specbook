import { PostPaymentIntents } from '#api/stripe'

export default PostPaymentIntents.request({
  name: 'Create a payment intent',
  init: {
    amount: 2000,
    currency: 'usd',
    customerId: 'cus_mock_123',
    paymentMethod: 'pm_card_visa',
  },
  data: {
    amount: '{{amount}}',
    currency: '{{currency}}',
    customer: '{{customerId}}',
    payment_method: '{{paymentMethod}}',
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  },
  capture: { intentId: (res) => (res.status === 200 ? res.data.id : '') },
  assert: (res, { assert, vars }) => {
    assert.is(res.status, 200, 'intent created')
    if (res.status === 200) {
      assert.is(res.data.amount, vars.amount, 'amount matches')
      assert.is(res.data.currency, vars.currency, 'currency matches')
    }
  },
})
