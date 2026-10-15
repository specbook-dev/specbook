import { PlaceOrder } from '#api/petstore'

export default PlaceOrder.request({
  name: 'Place an order',
  init: { petId: 1001, quantity: 1 },
  data: {
    id: 5001,
    petId: '{{petId}}',
    quantity: '{{quantity}}',
    status: 'placed',
    complete: false,
  },
  capture: { orderId: (res) => (res.status === 200 ? res.data.id : undefined) },
  assert: (res, { assert, vars }) => {
    assert.is(res.status, 200, 'order placed')
    if (res.status === 200) assert.is(res.data.petId, vars.petId, 'order is for the chosen pet')
  },
  // Echo the request back so the mock behaves like a real order service.
  mock: {
    responses: {
      200: {
        id: 5001,
        petId: '{{petId}}',
        quantity: '{{quantity}}',
        status: 'placed',
        complete: false,
      },
    },
  },
})
