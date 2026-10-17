var e=`import { c, sequence } from '@specbook/core'
import findPets from '../requests/petstore/find-pets.req'
import getOrder from '../requests/petstore/get-order.req'
import placeOrder from '../requests/petstore/place-order.req'

// #region flow
export default sequence({
  id: 'adopt-pet',
  title: 'Adopt a pet',
  description: 'Find available pets, pick one, order it, then verify the order.',
  tags: ['petstore', 'smoke'],
  inputs: {
    quantity: c.number({ default: 1, min: 1, description: 'How many of the chosen pet to order.' }),
  },
})
  .step('Find available pets', findPets) // keeps the pets the response lists
  // QA picks a pet in the portal. An automated run is not asked and takes the first one
  .input('Choose a pet', (ctx) => ({
    petId: c.select(ctx.captured.pets, {
      label: (p) => \`\${p.name} (#\${p.id})\`,
      value: (p) => p.id as number,
      default: 0,
    }),
  }))
  .step('Place order', placeOrder) // sends the chosen petId and the quantity
  .step('Verify order', getOrder) // the order id from the last step is already filled in
// #endregion flow
`;export{e as default};