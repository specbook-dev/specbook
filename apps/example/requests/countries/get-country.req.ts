import { Query } from '#api/countries'

type Country = { name?: string; capital?: string }

/** A real keyless GraphQL API: `--env live` calls countries.trevorblades.com. */
export default Query.request({
  name: 'Get a country',
  init: { code: 'FR' },
  data: {
    query:
      'query ($code: ID!) { country(code: $code) { name capital currency languages { name } } }',
    variables: { code: '{{code}}' },
  },
  capture: {
    capital: (res) =>
      res.status === 200 ? (res.data.data?.country as Country | undefined)?.capital : undefined,
  },
  assert: (res, { assert, req }) => {
    assert.is(res.status, 200, 'ok')
    if (res.status !== 200) return
    assert.is(res.data.errors, undefined, 'no GraphQL errors')
    assert.ok(
      typeof (res.data.data?.country as Country | undefined)?.name === 'string',
      'country has a name',
    )
    assert.ok(String(req.body && JSON.stringify(req.body)).includes('"query"'), 'sent a query')
  },
})
