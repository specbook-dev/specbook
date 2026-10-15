import { GetOrderById } from '#api/petstore'

export default GetOrderById.request({
  name: 'Get an order',
  path: { orderId: '{{orderId}}' },
  init: { orderId: 5001, petId: 1001 },
  assert: (res, { assert, vars }) => {
    assert.is(res.status, 200, 'found')
    if (res.status === 200) assert.is(res.data.id, vars.orderId, 'same order')
  },
  mock: {
    responses: {
      200: {
        id: '{{orderId}}',
        petId: '{{petId}}',
        quantity: 1,
        status: 'placed',
        complete: false,
      },
    },
  },
})
