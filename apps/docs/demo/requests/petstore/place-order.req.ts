import { PlaceOrder } from '#api/petstore'

export default PlaceOrder.request({
  name: 'Place an order',
  tags: ['write'],
  init: { petId: 1, quantity: 1 },
  data: { petId: '{{petId}}', quantity: '{{quantity}}', status: 'placed', complete: false },
  capture: { orderId: (res) => (res.status === 200 ? res.data.id : undefined) },
  assert: (res, { assert, vars }) => {
    assert.is(res.status, 200, 'order placed')
    if (res.status === 200) assert.is(res.data.petId, Number(vars.petId), 'order is for the pet')
  },
})
