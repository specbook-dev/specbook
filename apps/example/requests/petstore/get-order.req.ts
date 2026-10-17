import { withMock } from '@specbook/core'
import { GetOrderById } from '#api/petstore'

export default withMock(
  GetOrderById.request({
    name: 'Get an order',
    tags: ['smoke'],
    path: { orderId: '{{orderId}}' },
    init: { orderId: 5001, petId: 1001 },
    assert: (res, { assert, vars }) => {
      assert.is(res.status, 200, 'found')
      if (res.status === 200) assert.is(res.data.id, vars.orderId, 'same order')
    },
  }),
  // A stored order remembers its pet. A GET carries no body to echo it from, so the mock says so.
  (req, res) => {
    if (res.status === 200) res.data.petId = Number(req.vars.petId)
  },
)
