import { describe, expect, it } from 'vitest'
import { collectPlaceholders, deepMerge, render, TemplateError } from '../src'

describe('template', () => {
  const scope = { firstName: 'Ada', qty: 3, list: [1, 2], nested: { a: 'x' } }

  it('whole-string placeholders keep raw types', () => {
    expect(render({ q: '{{qty}}', l: '{{list}}' }, scope)).toEqual({ q: 3, l: [1, 2] })
  })
  it('embedded placeholders stringify', () => {
    expect(render('Hello {{firstName}} x{{qty}}', scope)).toBe('Hello Ada x3')
  })
  it('supports dotted paths', () => {
    expect(render('{{nested.a}}', scope)).toBe('x')
  })
  it('throws on missing variables', () => {
    expect(() => render('{{nope}}', scope)).toThrow(TemplateError)
  })
  it('leaves secrets.* and session.* untouched', () => {
    expect(render({ h: 'Bearer {{session.accessToken}}', k: '{{secrets.KEY}}' }, scope)).toEqual({
      h: 'Bearer {{session.accessToken}}',
      k: '{{secrets.KEY}}',
    })
  })
  it('collects placeholders', () => {
    expect([...collectPlaceholders({ a: '{{x}}', b: ['{{secrets.Y}} {{z}}'] })].sort()).toEqual([
      'secrets.Y',
      'x',
      'z',
    ])
  })
  it('deepMerge merges objects and replaces arrays', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { c: 3 }, l: [9] })).toEqual({
      a: { b: 1, c: 3 },
      l: [9],
    })
  })
})
