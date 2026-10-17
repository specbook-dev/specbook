import { describe, expect, it } from 'vitest'
import { short, show } from '../src/panel/short'

describe('show and short, for whatever a run hands the page', () => {
  it('name a value JSON cannot write, and never throw', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const v of [undefined, () => 1, circular, BigInt(5), Symbol('x'), Object.create(null)]) {
      expect(() => show(v)).not.toThrow()
      expect(typeof show(v)).toBe('string')
      expect(() => short(v)).not.toThrow()
    }
    expect(show(undefined)).toBe('undefined')
    expect(show(BigInt(5))).toBe('5')
    expect(show(circular)).toBe('[object Object]')
  })
  it('keep a value JSON can write, indented on request', () => {
    expect(show({ a: 1 })).toBe('{"a":1}')
    expect(show({ a: 1 }, 2)).toBe('{\n  "a": 1\n}')
    expect(show('x')).toBe('"x"')
  })
  it('cut a long value for a line, and keep a short one whole', () => {
    expect(short('abc')).toBe('abc')
    expect(short('x'.repeat(40))).toBe(`${'x'.repeat(27)}…`)
    expect(short({ a: 1 })).toBe('{"a":1}')
  })
})
