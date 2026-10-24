import { describe, expect, it } from 'vitest'
import { c, describeControls, resolveControls } from '../src'

describe('controls', () => {
  it('takes the first option when the default is not one of them: `default: 0` on pet ids is the first pet, not pet 0', () => {
    const pets = [
      { id: 4, name: 'Rex' },
      { id: 9, name: 'Tom' },
    ]
    const pick = (d: number) => c.select(pets, { value: (p) => p.id, default: d })
    expect(resolveControls({ pet: pick(0) })).toEqual({ pet: 4 })
    // a default that is one of the options is kept
    expect(resolveControls({ pet: pick(9) })).toEqual({ pet: 9 })
    // and what a person chose still wins
    expect(resolveControls({ pet: pick(0) }, { pet: 9 })).toEqual({ pet: 9 })
  })

  it('select resolves default by index, value, or first option', () => {
    const flights = [
      { id: 'a', code: 'X1' },
      { id: 'b', code: 'X2' },
    ]
    const ctl = c.select(flights, { value: (f) => f.id, default: 1 })
    expect(resolveControls({ f: ctl })).toEqual({ f: 'b' })
    expect(resolveControls({ f: c.select(flights, { value: (f) => f.id }) })).toEqual({ f: 'a' })
    expect(resolveControls({ f: ctl }, { f: 'a' })).toEqual({ f: 'a' })
  })
  it('rejects values that are not options and empty option lists', () => {
    expect(() => resolveControls({ f: c.select(['A', 'B'] as const) }, { f: 'Z' })).toThrow()
    expect(() => resolveControls({ f: c.select([] as string[]) })).toThrow(/No options/)
  })
  it('arrays of objects enforce min/max and resolve nested defaults', () => {
    const t = c.array(c.object({ firstName: c.text({ default: 'Jo' }) }), { min: 1, max: 2 })
    expect(resolveControls({ t }, { t: [{}, { firstName: 'Al' }] })).toEqual({
      t: [{ firstName: 'Jo' }, { firstName: 'Al' }],
    })
    expect(() => resolveControls({ t }, { t: [] })).toThrow(/at least/)
  })
  it('a default can be a function, made fresh each time it is needed', () => {
    let n = 0
    const name = c.text({ default: () => `Person ${++n}` })
    expect(resolveControls({ name })).toEqual({ name: 'Person 1' })
    expect(resolveControls({ name })).toEqual({ name: 'Person 2' })
    // a value given wins, and the function is not called
    expect(resolveControls({ name }, { name: 'Ada' })).toEqual({ name: 'Ada' })
    expect(n).toBe(2)
    expect(resolveControls({ qty: c.number({ default: () => 7 }) })).toEqual({ qty: 7 })
  })
  it('describes a generated default by its value and says it is generated', () => {
    const d = describeControls({
      who: c.text({ default: () => 'Grace' }),
      fixed: c.text({ default: 'x' }),
    })
    expect(d.who).toEqual({ kind: 'text', default: 'Grace', generated: true })
    expect(d.fixed).toEqual({ kind: 'text', default: 'x', generated: false })
  })
  it('describes select options with labels', () => {
    const d = describeControls({
      f: c.select([{ id: 1, n: 'A' }], { label: (o) => o.n, value: (o) => o.id }),
    })
    expect(d.f).toEqual({ kind: 'select', options: [{ label: 'A', value: 1 }], default: 1 })
  })
  it('a list with no value given starts at its minimum, each item from its own defaults', () => {
    let n = 0
    const t = c.array(c.object({ name: c.text({ default: () => `P${++n}` }) }), { min: 2, max: 3 })
    expect(resolveControls({ t })).toEqual({ t: [{ name: 'P1' }, { name: 'P2' }] })
    expect(resolveControls({ t: c.array(c.text(), {}) })).toEqual({ t: [] })
  })
  it('names the path of a value that is wrong', () => {
    const t = c.array(c.object({ gender: c.select(['F', 'M'] as const) }), { min: 1 })
    expect(() => resolveControls({ t }, { t: [{ gender: 'F' }, { gender: 'Z' }] })).toThrow(
      /t\[1\]\.gender/,
    )
    expect(() =>
      resolveControls({ g: c.object({ x: c.select(['a'] as const) }) }, { g: { x: 'b' } }),
    ).toThrow(/g\.x/)
  })
  it('describes groups and lists with their shape, labels and limits', () => {
    const d = describeControls({
      who: c.object({ name: c.text({ label: 'Name', default: 'x' }) }, { label: 'Traveler 1' }),
      all: c.array(c.object({ n: c.number({ min: 1 }) }), { min: 1, max: 4, label: 'Travelers' }),
    })
    expect(d.who).toMatchObject({
      kind: 'object',
      label: 'Traveler 1',
      shape: { name: { kind: 'text', label: 'Name', default: 'x' } },
    })
    expect(d.all).toMatchObject({
      kind: 'array',
      min: 1,
      max: 4,
      label: 'Travelers',
      item: { kind: 'object', shape: { n: { kind: 'number', min: 1 } } },
    })
  })
  it('a list can start from a function that names only some fields of each item', () => {
    let n = 0
    const t = c.array(
      c.object({
        name: c.text({ default: () => `P${++n}` }),
        role: c.text({ default: 'companion' }),
      }),
      { min: 1, default: () => [{ role: 'primary' }, {}] },
    )
    expect(resolveControls({ t })).toEqual({
      t: [
        { name: 'P1', role: 'primary' },
        { name: 'P2', role: 'companion' },
      ],
    })
    expect(describeControls({ t }).t).toMatchObject({ default: [{ role: 'primary' }, {}] })
  })
})
