var e=`import { c, sequence } from '@specbook/core'
import { faker } from '@specbook/core/faker'
import addPet from '../requests/petstore/add-pet.req'
import getPet from '../requests/petstore/get-pet.req'

// #region flow
export default sequence({
  id: 'new-pet',
  title: 'Register a pet',
  description: 'Name a pet, add it to the store and fetch it back.',
  tags: ['petstore', 'smoke'],
  inputs: {
    // a different name every run; QA can edit it or press Generate for another
    petName: c.text({
      default: () => faker.person.firstName(),
      description: 'What the new pet is called.',
    }),
  },
})
  .step('Add the pet', addPet) // keeps the id the store gave it
  .step('Fetch it back', (ctx) =>
    getPet.with({
      vars: { petId: ctx.captured.addedPetId },
      assert: (res, { assert, vars }) => {
        assert.is(res.status, 200, 'found')
        if (res.status === 200) assert.is(res.data.id, Number(vars.petId), 'the pet that was added')
      },
    }),
  )
// #endregion flow
`;export{e as default};