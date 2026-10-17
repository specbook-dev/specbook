import { faker } from '@specbook/core/faker'
import { AddPet } from '#api/petstore'

// #region request
export default AddPet.request({
  name: 'Add a pet',
  tags: ['write'],
  init: { petId: 1001, petName: () => faker.person.firstName() },
  data: {
    id: '{{petId}}',
    name: '{{petName}}',
    photoUrls: ['https://example.com/{{petName}}.png'],
    status: 'available',
  },
  capture: { addedPetId: (res) => (res.status === 200 ? res.data.id : 0) },
  assert: (res, { assert, vars }) => {
    assert.is(res.status, 200, 'pet created')
    if (res.status === 200) assert.is(res.data.name, vars.petName, 'echoes the name')
  },
})
// #endregion request
