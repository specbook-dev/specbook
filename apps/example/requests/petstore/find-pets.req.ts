import { FindPetsByStatus } from '#api/petstore'

export default FindPetsByStatus.request({
  name: 'Find pets by status',
  tags: ['smoke'],
  query: { status: '{{defaultStatus}}' },
  capture: { pets: (res) => (res.status === 200 ? res.data : []) },
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'ok')
    if (res.status === 200) assert.ok(res.data.length > 0, 'returns at least one pet')
  },
})
