import { Query } from '#api/countries'

/** A real keyless GraphQL API: `--env live` calls countries.trevorblades.com. */
export default Query.request({
  name: 'Get a country',
  example: 'country',
  init: { code: 'FR' },
  data: { variables: { code: '{{code}}' } },
  capture: { capital: (res) => (res.status === 200 ? res.data.data?.country?.capital : undefined) },
  assert: (res, { assert, req }) => {
    assert.is(res.status, 200, 'ok')
    if (res.status !== 200) return
    assert.is(res.data.errors, undefined, 'no GraphQL errors')
    assert.ok(typeof res.data.data?.country?.name === 'string', 'country has a name')
    assert.ok(String(req.body && JSON.stringify(req.body)).includes('"query"'), 'sent a query')
  },
  mock: {
    responses: {
      // `{ data }` is the mock wrapper, so the GraphQL `data` object sits one level down
      200: {
        data: {
          data: {
            country: {
              name: 'France',
              capital: 'Paris',
              currency: 'EUR',
              languages: [{ name: 'French' }],
            },
          },
        },
      },
    },
  },
})
