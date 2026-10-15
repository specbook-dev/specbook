import { PostCustomers } from '#api/stripe'

/** Builds on our own `PostCustomers/acme-vip.example.json` instead of repeating its body. */
export default PostCustomers.request({
  name: 'Create a VIP customer',
  example: 'acme-vip',
  assert: (res, { assert, req }) => {
    assert.is(res.status, 200, 'customer created')
    assert.is(
      (req.body as { metadata: { tier: string } }).metadata.tier,
      'vip',
      'sent the VIP tier',
    )
  },
})
