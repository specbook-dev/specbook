import { c, sequence } from '@specbook/core'
import findPets from '../requests/petstore/find-pets.req'
import getOrder from '../requests/petstore/get-order.req'
import placeOrder from '../requests/petstore/place-order.req'

export default sequence({
  id: 'adopt-pet',
  title: 'Adopt a pet',
  description: 'Find available pets, pick one, order it, then verify the order.',
  tags: ['petstore', 'smoke'],
  params: {
    quantity: c.number({
      default: 1,
      min: 1,
      description: 'How many of the chosen pet to order.',
    }),
  },
})
  .step('Find available pets', findPets)
  .input('Choose a pet', (ctx) => ({
    petId: c.select(ctx.captured.pets, {
      label: (p) => `${p.name} (#${p.id})`,
      value: (p) => p.id as number,
      default: 0,
    }),
  }))
  .step('Place order', placeOrder)
  .step(
    'Verify order',
    getOrder.with({
      assert: (res, { assert, vars }) => {
        assert.is(res.status, 200, 'order found')
        if (res.status === 200)
          assert.is(res.data.petId, vars.petId, 'order matches the chosen pet')
      },
    }),
  )
