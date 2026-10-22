import { SandboxPublicTokenCreate } from '#api/plaid'

export default SandboxPublicTokenCreate.request({
  name: 'Create a sandbox public token',
  tags: ['smoke'],
  // First Platypus Bank, one of Plaid's Sandbox test institutions.
  data: {
    institution_id: 'ins_109508',
    initial_products: ['transactions'],
  },
  capture: {
    publicToken: (res) => (res.status === 200 ? res.data.public_token : undefined),
  },
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'public token created')
    if (res.status === 200) {
      assert.type(res.data.public_token, 'string', 'response has a public_token')
      assert.match(res.data.public_token, /^public-/, 'token looks like a public token')
    }
  },
})
