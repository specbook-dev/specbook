import { describe, expect, it } from 'vitest'
import { nameOf, subtypeTag, unionOf } from '../src/union'

const schemas: Record<string, any> = {
  Media: {
    discriminator: {
      propertyName: 'kind',
      mapping: { book: 'Book', album: '#/components/schemas/Album' },
    },
    properties: { kind: { type: 'string' } },
  },
  Book: {
    allOf: [{ $ref: '#/components/schemas/Media' }, { properties: { pages: { type: 'integer' } } }],
  },
  Album: {
    allOf: [
      { $ref: '#/components/schemas/Media' },
      { properties: { tracks: { type: 'integer' } } },
    ],
  },
  Zine: {
    allOf: [{ $ref: '#/components/schemas/Media' }, { properties: { issue: { type: 'integer' } } }],
  },
  // a subtype of a subtype
  Hardback: { allOf: [{ $ref: '#/components/schemas/Book' }] },
  Loop: { allOf: [{ $ref: '#/components/schemas/Loop' }] },
  A: { properties: { code: { enum: ['a'] } } },
  B: { properties: { code: { const: 'b' } } },
}
const ctx = { resolve: (ref: string) => schemas[nameOf(ref)] }
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` })

describe('subtypeTag', () => {
  it('reads the value from the base’s mapping, whether it names the schema or refs it', () => {
    expect(subtypeTag('#/components/schemas/Book', ctx)).toEqual({ prop: 'kind', value: 'book' })
    expect(subtypeTag('#/components/schemas/Album', ctx)).toEqual({ prop: 'kind', value: 'album' })
  })

  it('names a schema the mapping leaves out by itself', () => {
    expect(subtypeTag('#/components/schemas/Zine', ctx)).toEqual({ prop: 'kind', value: 'Zine' })
  })

  it('looks through a base’s own bases, and stops at a cycle', () => {
    expect(subtypeTag('#/components/schemas/Hardback', ctx)?.prop).toBe('kind')
    expect(subtypeTag('#/components/schemas/Loop', ctx)).toBeUndefined()
  })

  it('has nothing to say about a schema that extends no discriminator', () => {
    expect(subtypeTag('#/components/schemas/A', ctx)).toBeUndefined()
  })
})

describe('unionOf', () => {
  it('is not a union when fewer than two real alternatives are left', () => {
    expect(unionOf({ anyOf: [ref('Book'), { type: 'null' }] }, ctx)).toBeUndefined()
    const placeholder = { type: 'string', pattern: '^\\{\\{' }
    const ignore = (b: any) => b === placeholder
    expect(
      unionOf({ anyOf: [{ type: 'string' }, placeholder] }, { ...ctx, ignore }),
    ).toBeUndefined()
    expect(unionOf({ type: 'object' }, ctx)).toBeUndefined()
  })

  it('tells branches apart by a discriminator on a base', () => {
    const u = unionOf({ oneOf: [ref('Book'), ref('Album'), ref('Zine')] }, ctx)
    expect(u?.tagProp).toBe('kind')
    expect(u?.tagSource).toBe('discriminator')
    expect(u?.branches.map((b) => `${b.name}=${b.tag}`)).toEqual([
      'Book=book',
      'Album=album',
      'Zine=Zine',
    ])
  })

  it('tells branches apart by a discriminator on the union itself', () => {
    const u = unionOf(
      { oneOf: [ref('A'), ref('B')], discriminator: { propertyName: 'code', mapping: { x: 'A' } } },
      ctx,
    )
    expect(u?.branches.map((b) => b.tag)).toEqual(['x', 'B'])
  })

  it('tells branches apart by a property each pins to its own value', () => {
    const u = unionOf({ anyOf: [ref('A'), ref('B')] }, ctx)
    expect(u?.tagProp).toBe('code')
    expect(u?.tagSource).toBe('enum')
    expect(u?.branches.map((b) => b.tag)).toEqual(['a', 'b'])
  })

  it('is a union without a tag when nothing tells the branches apart', () => {
    const u = unionOf({ oneOf: [{ properties: { x: { type: 'string' } } }, ref('Book')] }, ctx)
    expect(u?.branches).toHaveLength(2)
    expect(u?.tagProp).toBeUndefined()
  })

  it('keeps a union with one branch that has its own discriminator', () => {
    const u = unionOf({ oneOf: [ref('Book')], discriminator: { propertyName: 'kind' } }, ctx)
    expect(u?.branches).toHaveLength(1)
    expect(u?.tagProp).toBe('kind')
  })
})
