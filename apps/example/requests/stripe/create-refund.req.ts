import { PostRefunds } from '#api/stripe'

export default PostRefunds.request({
  name: 'Refund a payment',
  init: { intentId: 'pi_mock_123' },
  data: { payment_intent: '{{intentId}}' },
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'refund created')
    if (res.status === 200) assert.is(res.data.status, 'succeeded', 'refund succeeded')
  },
  mock: {
    responses: { 200: { id: 're_mock_123', payment_intent: '{{intentId}}', status: 'succeeded' } },
  },
})
