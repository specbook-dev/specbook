var e=`import { withMock } from '@specbook/core'
import { GetOrderById } from '#api/petstore'

export default withMock(
  GetOrderById.request({
    name: 'Get an order',
    tags: ['smoke'],
    path: { orderId: '{{orderId}}' },
    init: { orderId: 5001, petId: 1 },
    assert: (res, { assert, vars }) => {
      assert.is(res.status, 200, 'found')
      if (res.status === 200) {
        assert.is(res.data.id, Number(vars.orderId), 'same order')
        assert.is(res.data.status, 'placed', 'still placed')
      }
    },
  }),
  // The example order is approved; one just placed is "placed".
  (_req, res) => {
    if (res.status === 200) res.data.status = 'placed'
  },
)
`;export{e as default};