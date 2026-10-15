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
  it('describes select options with labels', () => {
    const d = describeControls({
      f: c.select([{ id: 1, n: 'A' }], { label: (o) => o.n, value: (o) => o.id }),
    })
    expect(d.f).toEqual({ kind: 'select', options: [{ label: 'A', value: 1 }] })
  })
})
