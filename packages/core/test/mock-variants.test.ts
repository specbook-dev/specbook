import { describe, expect, it } from 'vitest'
import { isMockVariants, MOCK_VARIANTS, mockVariantNames, pickMockVariant } from '../src/internal'

const file = {
  $variants: [
    { name: 'OutOfStock', tag: 'OUT_OF_STOCK', body: { error: 'OUT_OF_STOCK' } },
    { name: 'Discontinued', title: 'Gone', body: { error: 'DISCONTINUED' } },
  ],
}

describe('mock variants', () => {
  it('names the key the generated files use', () => {
    expect(MOCK_VARIANTS).toBe('$variants')
  })

  it('knows a file that holds variants, and nothing else', () => {
    expect(isMockVariants(file)).toBe(true)
    // a bare body, even an object, is not one
    for (const bare of [{ id: 1 }, [file], 'x', 7, null, undefined, {}])
      expect(isMockVariants(bare)).toBe(false)
    // `$variants` alongside anything else is a body that happens to have that field
    expect(isMockVariants({ ...file, extra: 1 })).toBe(false)
    expect(isMockVariants({ $variants: [] })).toBe(false)
    expect(isMockVariants({ $variants: [{ body: 1 }] })).toBe(false)
    expect(isMockVariants({ $variants: [{ name: 'a' }] })).toBe(false)
  })

  it('picks the variant asked for, else the first, and leaves a bare body alone', () => {
    expect(pickMockVariant(file, 'Discontinued')).toEqual({ error: 'DISCONTINUED' })
    expect(pickMockVariant(file)).toEqual({ error: 'OUT_OF_STOCK' })
    expect(pickMockVariant(file, 'Nope')).toEqual({ error: 'OUT_OF_STOCK' })
    const bare = { id: 1 }
    expect(pickMockVariant(bare, 'Discontinued')).toBe(bare)
    expect(pickMockVariant(undefined)).toBeUndefined()
  })

  it('lists the names a file offers', () => {
    expect(mockVariantNames(file)).toEqual(['OutOfStock', 'Discontinued'])
    expect(mockVariantNames({ id: 1 })).toEqual([])
  })
})
