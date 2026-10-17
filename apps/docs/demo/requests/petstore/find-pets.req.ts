import { FindPetsByStatus } from '#api/petstore'

// #region request
export default FindPetsByStatus.request({
  name: 'Find pets by status',
  tags: ['smoke', 'monitor'],
  query: { status: '{{status}}' },
  init: { status: 'available' },
  // keep the pets the response lists: a flow can pick one of them
  capture: { pets: (res) => (res.status === 200 ? res.data : []) },
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'ok')
    if (res.status === 200) assert.ok(res.data.length > 0, 'returns at least one pet')
  },
})
// #endregion request
