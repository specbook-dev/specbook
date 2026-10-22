import { SandboxPublicTokenCreate } from '#api/plaid'

// Sandbox only: /sandbox/* does not exist on production, so this is not tagged `monitor`.
export default SandboxPublicTokenCreate.request({
  name: 'Create sandbox public token',
  tags: ['plaid', 'sandbox'],
  // First Platypus Bank, Plaid's standard sandbox institution.
  init: { institutionId: 'ins_109508' },
  data: {
    institution_id: '{{institutionId}}',
    initial_products: ['transactions'],
  },
  capture: {
    publicToken: (res) => (res.status === 200 ? res.data.public_token : undefined),
  },
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'sandbox item created')
    if (res.status === 200) {
      assert.type(res.data.public_token, 'string', 'public_token is a string')
      assert.match(res.data.public_token, /^public-sandbox-/, 'public_token is a sandbox token')
      assert.ok(res.data.request_id, 'request_id is returned')
    }
  },
})
