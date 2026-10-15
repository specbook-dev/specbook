import { sequence } from '@specbook/core'
import confirm from '../requests/stripe/confirm-payment-intent.req'
import createCustomer from '../requests/stripe/create-customer.req'
import createIntent from '../requests/stripe/create-payment-intent.req'

const DECLINED = 'pm_card_chargeDeclined'

export default sequence({
  id: 'stripe-declined-card',
  title: 'Stripe declined card',
  description: 'A declined test card must produce a 402 card_declined error.',
  tags: ['stripe'],
})
  .step('Create customer', createCustomer)
  // Stripe rejects a declined card at confirmation, so the intent is created with a good one.
  .step('Create payment intent', createIntent)
  .step(
    'Confirm with declined card',
    confirm.with({
      vars: { paymentMethod: DECLINED },
      assert: (res, { assert }) => {
        assert.is(res.status, 402, 'declined with 402')
        if (res.status === 402) assert.is(res.data.error.code, 'card_declined', 'card_declined')
      },
    }),
  )
