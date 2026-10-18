import { describe, expect, it } from 'vitest'
import {
  collectPlaceholders,
  deepMerge,
  FakerPlaceholderError,
  render,
  rootName,
  setFaker,
  TemplateError,
} from '../src'

describe('template', () => {
  const scope = { firstName: 'Ada', qty: 3, list: [1, 2], nested: { a: 'x' } }

  it('whole-string placeholders keep raw types', () => {
    expect(render({ q: '{{qty}}', l: '{{list}}' }, scope)).toEqual({ q: 3, l: [1, 2] })
  })
  it('embedded placeholders stringify', () => {
    expect(render('Hello {{firstName}} x{{qty}}', scope)).toBe('Hello Ada x3')
  })
  it('carries whole objects and arrays of objects, not only scalars', () => {
    const pet = { id: 7, category: { id: 1, name: 'Dogs' }, tags: [{ id: 5, name: 'good' }] }
    const body = render(
      { category: '{{pet.category}}', tags: '{{pet.tags}}', pet: '{{pet}}' },
      { pet },
    )
    expect(body).toEqual({ category: pet.category, tags: pet.tags, pet })
    // the same object, handed over, not a copy turned into text
    expect(body.pet).toBe(pet)
  })
  it('lets a whole body be one placeholder', () => {
    expect(render('{{order}}', { order: { sku: 'a', qty: 2 } })).toEqual({ sku: 'a', qty: 2 })
  })
  it('turns an object inside a longer string into JSON, and a scalar into text', () => {
    expect(render('copy of {{c.name}} / {{c}}', { c: { id: 1, name: 'Dogs' } })).toBe(
      'copy of Dogs / {"id":1,"name":"Dogs"}',
    )
  })
  it('reaches into arrays by position, with a dot or with brackets', () => {
    const scope = {
      tags: [{ id: 5, name: 'good' }],
      grid: [
        [1, 2],
        [3, 4],
      ],
    }
    expect(render('{{tags.0.name}}', scope)).toBe('good')
    expect(render('{{tags[0].name}}', scope)).toBe('good')
    expect(render('{{tags[0]}}', scope)).toEqual({ id: 5, name: 'good' })
    expect(render('{{grid[1][0]}}', scope)).toBe(3)
    expect(render('{{grid.1.0}}', scope)).toBe(3)
    expect(render('n = {{tags[0].id}}', scope)).toBe('n = 5')
  })
  it('fails loudly for a position that is not there, or is not a position', () => {
    const scope = { tags: [{ id: 5, name: 'good' }], pet: { name: 'Rex' } }
    for (const bad of [
      'tags.1.name',
      'tags[1].name',
      'tags[-1]',
      'tags[x]',
      'tags[0',
      'tags[]',
      '[0]',
      'pet[0]',
    ])
      expect(() => render(`{{${bad}}}`, scope), bad).toThrow(TemplateError)
  })
  it("reads a value's own properties only, not what every object inherits", () => {
    const scope = { pet: { name: 'Rex' }, tags: [1, 2, 3] }
    for (const inherited of [
      'pet.toString',
      'pet.constructor',
      'pet.__proto__',
      'pet.hasOwnProperty',
      'tags.map',
    ])
      expect(() => render(`{{${inherited}}}`, scope), inherited).toThrow(TemplateError)
    // an array's length is its own, and counts what is in it
    expect(render('{{tags.length}}', scope)).toBe(3)
    // a value that is itself named like an inherited method is still data
    expect(render('{{o.toString}}', { o: { toString: 'x' } })).toBe('x')
  })
  it('names the variable a placeholder starts from', () => {
    expect(rootName('pet')).toBe('pet')
    expect(rootName('pet.category.name')).toBe('pet')
    expect(rootName('tags[0].name')).toBe('tags')
    expect(rootName('grid[1][0]')).toBe('grid')
    expect([...collectPlaceholders({ a: '{{tags[0].name}} {{pet.id}}' })]).toEqual([
      'tags[0].name',
      'pet.id',
    ])
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

describe('faker placeholders', () => {
  const fake = {
    person: { firstName: () => 'Ada' },
    number: { int: () => 7 },
    seed: () => 'seeded',
  }
  const withFaker = (fn: () => void) => {
    setFaker(fake)
    try {
      fn()
    } finally {
      setFaker(undefined)
    }
  }

  it('fills faker.<module>.<method>', () =>
    withFaker(() => {
      expect(render('{{faker.person.firstName}}', {})).toBe('Ada')
      expect(render('id-{{ faker.number.int }}', {})).toBe('id-7')
    }))

  it('names a misspelt generator, not a missing variable', () =>
    withFaker(() => {
      const run = () => render('{{faker.person.fistName}}', {})
      expect(run).toThrow(FakerPlaceholderError)
      expect(run).toThrow(/Unknown faker generator "\{\{faker\.person\.fistName\}\}"/)
      expect(run).not.toThrow(/Missing variable/)
    }))

  it('accepts only faker.<module>.<method>', () =>
    withFaker(() => {
      for (const bad of ['faker.person', 'faker.seed', 'faker.person.constructor', 'faker.a.b.c'])
        expect(() => render(`{{${bad}}}`, {}), bad).toThrow(FakerPlaceholderError)
    }))

  it('refuses a call with arguments instead of sending it as it is', () =>
    withFaker(() => {
      expect(() => render('{{faker.number.int(5)}}', {})).toThrow(/takes no arguments|no arguments/)
      expect(() => render({ a: ['x {{faker.number.int({max:5})}}'] }, {})).toThrow(
        FakerPlaceholderError,
      )
    }))
})
