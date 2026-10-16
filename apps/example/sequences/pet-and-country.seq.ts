import { sequence } from '@specbook/core'
import getCountry from '../requests/countries/get-country.req'
import findPets from '../requests/petstore/find-pets.req'

/** One flow, two APIs: each step goes to its own service's address, with that service's credentials. */
export default sequence({
  id: 'pet-and-country',
  title: 'Find a pet, look up a country',
  description: 'A flow that spans services: the pet store, then the countries API.',
  tags: ['petstore', 'countries', 'smoke'],
})
  .step('Find available pets', findPets)
  .step('Look up a country', getCountry)
