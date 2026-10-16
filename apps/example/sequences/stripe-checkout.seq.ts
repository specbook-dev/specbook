import { c, sequence } from '@specbook/core'
import { faker } from '@specbook/core/faker'
import confirm from '../requests/stripe/confirm-payment-intent.req'
import createCustomer from '../requests/stripe/create-customer.req'
import createIntent from '../requests/stripe/create-payment-intent.req'
import refund from '../requests/stripe/create-refund.req'

export default sequence({
  id: 'stripe-checkout',
  title: 'Stripe checkout and refund',
  description:
    'Customer → payment intent → confirm with a test card → refund. Use Stripe test mode only.',
  tags: ['stripe'],
  inputs: {
    fullName: c.text({
      default: () => faker.person.fullName(),
      description: 'The customer to create.',
    }),
    amount: c.number({ default: 2000, min: 50 }),
    currency: c.select(['usd', 'eur', 'gbp'] as const, { default: 'usd' }),
    paymentMethod: c.select(['pm_card_visa', 'pm_card_mastercard'] as const, {
      default: 'pm_card_visa',
    }),
  },
})
  .step('Create customer', createCustomer)
  .step('Create payment intent', createIntent)
  .step('Confirm payment', confirm)
  .step('Refund', refund)
