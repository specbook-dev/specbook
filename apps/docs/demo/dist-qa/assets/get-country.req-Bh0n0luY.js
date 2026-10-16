var e=`import { Query } from '#api/countries'

type Country = { name?: string; capital?: string }

// #region request
export default Query.request({
  name: 'Get a country',
  tags: ['smoke'],
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
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'ok')
    if (res.status !== 200) return
    assert.is(res.data.errors, undefined, 'no GraphQL errors')
    assert.ok(
      typeof (res.data.data?.country as Country | undefined)?.name === 'string',
      'country has a name',
    )
  },
})
// #endregion request
`;export{e as default};