var e=`import { GetPetById } from '#api/petstore'

// #region request
export default GetPetById.request({
  name: 'Get a pet',
  tags: ['smoke', 'monitor'],
  path: { petId: '{{petId}}' },
  init: { petId: 1 },
  assert: (res, { assert, vars }) => {
    assert.is(res.status, 200, 'found')
    if (res.status === 200) assert.is(res.data.id, Number(vars.petId), 'the pet that was asked for')
  },
})
// #endregion request
`;export{e as default};