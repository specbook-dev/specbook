import { describe, expect, it } from 'vitest'
import { isTemplate, kindOf, propsOf, summary, unwrap, validate } from '../src/schema'

const PLACEHOLDER = { type: 'string', pattern: '^\\s*\\{\\{[^}]+\\}\\}\\s*$' }
const defs = {
  $defs: {
    Pet: {
      type: 'object',
      description: 'A pet in the store.\nMore detail here.',
      required: ['name', 'photoUrls'],
      properties: {
        id: { description: 'unique id', anyOf: [{ type: 'integer' }, PLACEHOLDER] },
        name: { type: 'string', description: 'display name' },
        status: {
          description: 'pet status',
          anyOf: [{ enum: ['available', 'sold'] }, PLACEHOLDER],
        },
        photoUrls: { type: 'array', items: { type: 'string' } },
      },
    },
  },
}
const pet = { $ref: 'specbook://x/defs#/$defs/Pet' }

describe('schema helpers', () => {
  it('resolves refs and unwraps the placeholder alternative, keeping docs', () => {
    const id = unwrap(propsOf(pet, defs).find((p) => p.name === 'id')?.schema, defs)
    expect(kindOf(id)).toBe('integer')
    expect(id.description).toBe('unique id')
    expect(kindOf(unwrap(pet, defs))).toBe('object')
  })

  it('knows required props and summarises descriptions', () => {
    expect(
      propsOf(pet, defs)
        .filter((p) => p.required)
        .map((p) => p.name),
    ).toEqual(['name', 'photoUrls'])
    expect(summary('A pet in the store.\nMore detail here.')).toBe('A pet in the store.')
  })

  it('validates types, enums and required fields; templates are always accepted', () => {
    const issues = validate({ id: 'x', status: 'nope' }, pet, defs)
    const msgs = issues.map((i) => `${i.path}:${i.kind}`).sort()
    expect(msgs).toEqual(['id:type', 'name:required', 'photoUrls:required', 'status:enum'])
    expect(
      validate({ id: '{{petId}}', name: '{{n}}', photoUrls: [], status: 'sold' }, pet, defs),
    ).toEqual([])
    expect(isTemplate(' {{a}} ')).toBe(true)
  })

  it('reports fields that are not in the spec only when asked (response conformance)', () => {
    const value = { name: 'x', photoUrls: [], ownerId: 7 }
    expect(validate(value, pet, defs)).toEqual([])
    const issues = validate(value, pet, defs, { reportExtra: true })
    expect(issues).toEqual([{ path: 'ownerId', kind: 'extra', message: 'not in the spec' }])
  })
})

import { linePaths, pathString } from '../src/schema'

describe('linePaths', () => {
  it('maps each line of a JSON document to the key/element that starts on it', () => {
    const text = JSON.stringify(
      { data: { name: 'x', tags: [{ id: 1 }, { id: 2 }], status: 's' } },
      null,
      2,
    )
    const paths = linePaths(text).map((p) => (p ? pathString(p) : ''))
    expect(paths).toContain('data')
    expect(paths).toContain('data.name')
    expect(paths).toContain('data.tags')
    expect(paths).toContain('data.tags[0]')
    expect(paths).toContain('data.tags[0].id')
    expect(paths).toContain('data.tags[1].id')
    expect(paths).toContain('data.status')
  })

  it('keeps working on incomplete JSON while the user is typing', () => {
    const paths = linePaths('{\n  "data": {\n    "name": "x",\n    "sta').map((p) =>
      p ? pathString(p) : '',
    )
    expect(paths).toContain('data.name')
  })
})

describe('an optional field written the OpenAPI 3.1 way', () => {
  // what the conversion makes of `anyOf: [{ type: integer }, { type: 'null' }]` (FastAPI and Pydantic write every Optional so)
  const owner = {
    anyOf: [{ anyOf: [{ type: 'integer' }, PLACEHOLDER] }, { type: 'null' }],
    title: 'Owner Id',
  }
  const pet = { type: 'object', properties: { owner_id: owner } }

  it('accepts a null, an integer and a template', () => {
    expect(validate({ owner_id: null }, pet, {}, { reportExtra: true })).toEqual([])
    expect(validate({ owner_id: 7 }, pet, {}, { reportExtra: true })).toEqual([])
    expect(validate({ owner_id: '{{owner}}' }, pet, {}, { reportExtra: true })).toEqual([])
  })

  it('still refuses what neither branch allows', () => {
    expect(validate({ owner_id: 'seven' }, pet, {}).map((i) => i.path)).toEqual(['owner_id'])
  })
})
