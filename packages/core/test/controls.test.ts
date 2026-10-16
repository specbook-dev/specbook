import { describe, expect, it } from 'vitest'
import { c, describeControls, resolveControls } from '../src'

describe('controls', () => {
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
    expect(d.f).toEqual({ kind: 'select', options: [{ label: 'A', value: 1 }] })
  })
})
