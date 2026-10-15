import { Query } from '#api/countries'

export default Query.request({
  name: 'List continents',
  example: 'continents',
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'ok')
    if (res.status !== 200) return
    const continents = res.data.data?.continents as { code: string }[] | undefined
    assert.ok((continents?.length ?? 0) >= 6, 'at least six continents')
  },
  mock: {
    responses: {
      200: {
        data: {
          data: {
            continents: ['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA'].map((code) => ({
              code,
              name: code,
            })),
          },
        },
      },
    },
  },
})
