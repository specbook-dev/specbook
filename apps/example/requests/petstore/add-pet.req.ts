import { faker } from '@specbook/core/faker'
import { AddPet } from '#api/petstore'

export default AddPet.request({
  name: 'Add a pet',
  init: { petId: 1001, petName: () => faker.person.firstName() },
  // the body lives next to the operation as AddPet/rex.example.json; this request varies its own fields
  example: 'rex',
  data: {
    id: '{{petId}}',
    name: '{{petName}}',
    photoUrls: ['https://example.com/{{petName}}.png'],
  },
  capture: { addedPetId: (res) => (res.status === 200 ? res.data.id : 0) },
  assert: (res, { assert, vars }) => {
    assert.is(res.status, 200, 'pet created')
    if (res.status === 200) assert.is(res.data.name, vars.petName, 'echoes the name')
  },
})
