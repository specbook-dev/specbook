import { withMock } from '@specbook/core'
import { PostRefunds } from '#api/stripe'

export default withMock(
  PostRefunds.request({
    name: 'Refund a payment',
    init: { intentId: 'pi_mock_123' },
    data: { payment_intent: '{{intentId}}' },
    assert: (res, { assert }) => {
      assert.is(res.status, 200, 'refund created')
      if (res.status === 200) assert.is(res.data.status, 'succeeded', 'refund succeeded')
    },
  }),
  (_req, res) => {
    if (res.status === 200) res.data.status = 'succeeded'
  },
)
