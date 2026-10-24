import { c } from '@specbook/core'
import { describe, expect, it } from 'vitest'
import {
  anyGenerated,
  defaultFor,
  generatedCount,
  regenerate,
  specFromControl,
  startValues,
  summarize,
  withDefaults,
} from '../src/components/Fields'
import { blocksOf } from '../src/panel/ControlsGrid'

let n = 0
const person = c.object({
  name: c.text({ default: () => `P${++n}` }),
  gender: c.select(['F', 'M', 'X'] as const, { default: 'M' }),
  note: c.text({ default: 'hi' }),
})
const people = c.array(person, { min: 2, max: 4, label: 'Travelers' })

describe('input values of groups and lists', () => {
  it('a select starts where the CLI starts, not always at its first option', () => {
    expect(defaultFor(specFromControl(c.select(['a', 'b'] as const, { default: 'b' })))).toBe('b')
    expect(defaultFor(specFromControl(c.select(['a', 'b'] as const, { default: 1 })))).toBe('b')
  })

  it('a list starts at its minimum, each item from its own defaults', () => {
    const v = defaultFor(specFromControl(people)) as { name: string; gender: string }[]
    expect(v).toHaveLength(2)
    expect(v[0]?.gender).toBe('M')
    expect(v[0]?.name).not.toBe(v[1]?.name)
  })

  it('a list can start from a function: two items, each filled from its own defaults', () => {
    const t = c.array(person, { min: 1, default: () => [{ gender: 'F' }, {}] })
    const v = defaultFor(specFromControl(t)) as { name: string; gender: string }[]
    expect(v).toHaveLength(2)
    expect(v.map((p) => p.gender)).toEqual(['F', 'M'])
    expect(v[0]?.name).not.toBe(v[1]?.name)
  })

  it('a preset of one field of a group leaves the others at their defaults, and extra keys are kept', () => {
    const specs = { who: specFromControl(person), extra: specFromControl(c.text()) }
    const v = startValues(specs, { who: { name: 'Ada' }, unknown: 1 }) as {
      who: { name: string; gender: string; note: string }
      unknown: number
    }
    expect(v.who).toEqual({ name: 'Ada', gender: 'M', note: 'hi' })
    expect(v.unknown).toBe(1)
  })

  it('a preset list is filled per item and padded to the minimum', () => {
    const spec = specFromControl(people)
    const v = withDefaults(spec, [{ name: 'Ada' }]) as { name: string; gender: string }[]
    expect(v).toHaveLength(2)
    expect(v[0]).toMatchObject({ name: 'Ada', gender: 'M' })
  })

  it('finds generated fields inside groups and lists, and regenerates only those', () => {
    const spec = specFromControl(people)
    expect(anyGenerated(spec)).toBe(true)
    expect(anyGenerated(specFromControl(c.object({ a: c.text() })))).toBe(false)
    const v = [
      { name: 'x', gender: 'F', note: 'typed' },
      { name: 'y', gender: 'X', note: 'typed' },
    ]
    expect(generatedCount(spec, v)).toBe(2)
    const out = regenerate(spec, v) as typeof v
    expect(out.map((p) => p.gender)).toEqual(['F', 'X'])
    expect(out.map((p) => p.note)).toEqual(['typed', 'typed'])
    expect(out[0]?.name).not.toBe('x')
  })

  it('summarizes the inputs in a line', () => {
    const specs = {
      currency: specFromControl(c.select(['usd'] as const)),
      people: specFromControl(people),
      a: specFromControl(c.text()),
      b: specFromControl(c.text()),
    }
    expect(summarize(specs, { currency: 'usd', people: [1, 2], a: 'x', b: 'y' })).toBe(
      'currency usd · Travelers 2 · a x +1',
    )
  })
})

describe('how inputs are laid out', () => {
  const who = (label: string) =>
    specFromControl(c.object({ name: c.text(), gender: c.select(['F', 'M'] as const) }, { label }))
  const text = () => specFromControl(c.text())

  it('plain inputs are the rows of one table, groups of the same fields are the rows of another', () => {
    const blocks = blocksOf({ a: text(), b: text(), t1: who('One'), t2: who('Two'), c: text() })
    expect(blocks.map((b) => [b.kind, 'names' in b ? b.names : b.name])).toEqual([
      ['fields', ['a', 'b']],
      ['objects', ['t1', 't2']],
      ['fields', ['c']],
    ])
  })

  it('an input between two groups, or other fields, makes them separate tables', () => {
    expect(blocksOf({ t1: who('1'), x: text(), t2: who('2') }).map((b) => b.kind)).toEqual([
      'objects',
      'fields',
      'objects',
    ])
    const other = specFromControl(c.object({ name: c.text(), age: c.number() }))
    expect(blocksOf({ t1: who('1'), t2: other }).map((b) => b.kind)).toEqual(['objects', 'objects'])
  })

  it('a lone group is a table of one row, with a column for each field', () => {
    const [b] = blocksOf({ t1: who('One') })
    expect(b?.kind).toBe('objects')
    expect(b && 'columns' in b ? b.columns.map((col) => col.label) : []).toEqual(['name', 'gender'])
  })

  it('a list is a table of its own; of plain values it is one column', () => {
    const people = specFromControl(c.array(c.object({ name: c.text() })))
    const tags = specFromControl(c.array(c.text(), { label: 'Tags' }))
    const blocks = blocksOf({ people, tags })
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'list'])
    expect(
      blocks[1] && 'columns' in blocks[1] ? blocks[1].columns.map((x) => x.label) : [],
    ).toEqual(['Value'])
  })

  it('a group with no fields is an ordinary row', () => {
    expect(blocksOf({ empty: specFromControl(c.object({})) }).map((b) => b.kind)).toEqual([
      'fields',
    ])
  })
})
