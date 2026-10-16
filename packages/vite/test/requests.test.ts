import { describe, expect, it } from 'vitest'
import { parseRequestTarget } from '../src/requests'

const services = new Set(['petstore', 'stripe'])

describe('which operation a request file is for', () => {
  it('reads the operation from the import and the .request call', () => {
    expect(
      parseRequestTarget(
        `import { GetPetById } from '#api/petstore'\nexport default GetPetById.request({ path: { petId: 1 } })`,
        services,
      ),
    ).toBe('petstore/GetPetById')
  })

  it('follows an alias, any import prefix, and a .with call is not needed', () => {
    expect(
      parseRequestTarget(
        `import { PostCustomers as CreateCustomer, type Foo } from '@gen/stripe'\nexport default CreateCustomer\n  .request({})`,
        services,
      ),
    ).toBe('stripe/PostCustomers')
  })

  it('is undefined when the text does not settle it', () => {
    // a type-only import, no call, two operations, or a service that is not one of ours
    expect(
      parseRequestTarget(`import type { A } from '#api/petstore'\nA.request({})`, services),
    ).toBeUndefined()
    expect(
      parseRequestTarget(`import { A } from '#api/petstore'\nexport default A`, services),
    ).toBeUndefined()
    expect(
      parseRequestTarget(
        `import { A, B } from '#api/petstore'\nconst a = A.request({})\nconst b = B.request({})`,
        services,
      ),
    ).toBeUndefined()
    expect(
      parseRequestTarget(`import { A } from '#api/other'\nA.request({})`, services),
    ).toBeUndefined()
  })

  it('counts one operation used twice as one', () => {
    expect(
      parseRequestTarget(
        `import { A } from '#api/petstore'\nconst x = A.request({})\nexport default A.request({ name: 'y' })`,
        services,
      ),
    ).toBe('petstore/A')
  })
})
