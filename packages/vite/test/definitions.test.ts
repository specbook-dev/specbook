import { describe, expect, it } from 'vitest'
import { definitionRefs, pruneDefinitions } from '../src/definitions'

describe('definitionRefs', () => {
  it('finds the definitions a text refers to, by either spelling of the reference', () => {
    expect(
      definitionRefs(
        '{"a":{"$ref":"specbook://petstore/defs#/$defs/Pet"},"b":{"$ref":"#/$defs/Tag"},"c":{"$ref":"#/$defs/A~1B"}}',
      ),
    ).toEqual(['Pet', 'Tag', 'A/B'])
    expect(definitionRefs('{"type":"string"}')).toEqual([])
  })
})

describe('pruneDefinitions', () => {
  const defs = {
    $id: 'specbook://p/defs',
    $defs: {
      Pet: { properties: { tag: { $ref: 'specbook://p/defs#/$defs/Tag' } } },
      Tag: { type: 'object' },
      Order: { properties: { pet: { $ref: '#/$defs/Pet' } } },
      Unused: { type: 'string' },
    },
  }

  it('keeps what is referred to, and what those refer to, and nothing else', () => {
    const out = pruneDefinitions(defs, new Set(['Order']))
    expect(Object.keys(out.$defs)).toEqual(['Pet', 'Tag', 'Order'])
    expect(out.$id).toBe('specbook://p/defs')
  })

  it('keeps nothing when nothing is referred to, and ignores a name that is not defined', () => {
    expect(pruneDefinitions(defs, undefined).$defs).toEqual({})
    expect(Object.keys(pruneDefinitions(defs, new Set(['Gone'])).$defs)).toEqual([])
  })
})
