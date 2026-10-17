import { Query } from '#api/countries'

export default Query.request({
  name: 'List continents',
  tags: ['smoke'],
  data: { query: '{ continents { code name } }' },
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'ok')
    if (res.status !== 200) return
    const continents = res.data.data?.continents as { code: string }[] | undefined
    assert.ok((continents?.length ?? 0) >= 6, 'at least six continents')
  },
})
