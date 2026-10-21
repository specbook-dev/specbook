import { resolve } from 'node:path'
import { generate } from '@specbook/codegen'
import { beforeAll, describe, expect, it } from 'vitest'
import { fieldDoc } from '../src/fielddoc'
import { jsonCompletions } from '../src/panel/completions'
import { flatten } from '../src/panel/FieldTable'
import { jsonCursor } from '../src/panel/jsonCursor'
import { typeInfo, validate } from '../src/schema'

// the bookstore: a base holds the discriminator, its subtypes extend it, and the lists use a plain union of them
const spec = resolve(__dirname, '../../codegen/test/fixtures/bookstore.json')

let defs: any
let shelf: any
let conflict: any
let example: any
beforeAll(async () => {
  const { files } = await generate({ spec, service: 'books' })
  const json = (path: string) => JSON.parse(files.find((f) => f.path === path)?.content ?? 'null')
  defs = json('schemas/definitions.schema.json')
  const responses = json('schemas/ListShelf.responses.schema.json')
  shelf = responses['200']
  conflict = responses['409']
  example = json('examples/ListShelf/200.response.json')
})

const check = (value: unknown, schema = shelf) =>
  validate(value, schema, defs, { reportExtra: true })
const at = (items: unknown[]) => ({ name: 'Main', items })
const book = { kind: 'book', title: 'Dune', pages: 412 }
const album = { kind: 'album', title: 'Kind of Blue', tracks: 5 }

describe('a response whose lists hold variants of one family', () => {
  it('accepts the example generated for it', () => {
    expect(check(example)).toEqual([])
  })

  it('judges each item as the variant it names, not as the first one', () => {
    // an album has `tracks`, which a book does not: against the first variant it was "not in the spec"
    expect(check(at([book, album]))).toEqual([])
  })

  it('says what is wrong with an item against the variant it names', () => {
    expect(check(at([{ ...album, pages: 3 }])).map((i) => `${i.path}: ${i.message}`)).toEqual([
      'items[0].pages: not in the spec',
    ])
    expect(check(at([{ ...album, tracks: 'five' }])).map((i) => i.path)).toEqual([
      'items[0].tracks',
    ])
  })

  it('names the values the family allows when an item names none of them', () => {
    expect(check(at([book, { kind: 'banana' }]))).toEqual([
      { path: 'items[1].kind', kind: 'enum', message: 'must be one of: book · album · Zine' },
    ])
  })

  it('says only that, rather than judging the item as some variant it is not', () => {
    expect(check(at([{ kind: 'banana', title: 1, tracks: 'x', wings: true }]))).toHaveLength(1)
  })

  it('still reports an item that is not an object', () => {
    expect(check(at(['book'])).map((i) => i.message)).toEqual(['expected object, got string'])
  })
})

describe('a response whose variants are told apart by a value each pins', () => {
  it('judges an error as the variant its `error` names', () => {
    expect(check({ error: 'DISCONTINUED', message: 'gone', since: '2020' }, conflict)).toEqual([])
    expect(check({ error: 'OUT_OF_STOCK', sku: 'x-1' }, conflict)).toEqual([])
  })

  it('reports what is wrong with it against that variant', () => {
    // `sku` belongs to the other variant
    expect(
      check({ error: 'DISCONTINUED', sku: 'x-1' }, conflict).map((i) => `${i.path}: ${i.message}`),
    ).toEqual(['sku: not in the spec'])
  })

  it('names the allowed values for one it does not know', () => {
    expect(check({ error: 'NOPE' }, conflict)).toEqual([
      { path: 'error', kind: 'enum', message: 'must be one of: OUT_OF_STOCK · DISCONTINUED' },
    ])
  })
})

describe('a union with nothing to tell its variants apart', () => {
  const untagged = {
    $defs: {
      Money: {
        title: 'Money',
        type: 'object',
        required: ['amount', 'currency'],
        properties: { amount: { type: 'number' }, currency: { type: 'string' } },
      },
      Range: {
        title: 'Range',
        type: 'object',
        required: ['low', 'high'],
        properties: { low: { type: 'number' }, high: { type: 'number' } },
      },
    },
  }
  const price = { oneOf: [{ $ref: '#/$defs/Money' }, { $ref: '#/$defs/Range' }] }
  const run = (v: unknown) => validate(v, price, untagged, { reportExtra: true })

  it('takes the variant a value fits', () => {
    expect(run({ low: 1, high: 2 })).toEqual([])
    expect(run({ amount: 3, currency: 'USD' })).toEqual([])
  })

  it('reports against the variant a value comes closest to', () => {
    expect(run({ low: 1, high: 'x' }).map((i) => `${i.path}: ${i.message}`)).toEqual(
      ['high: expected number'].map((m) =>
        m.replace('expected number', 'expected number, got string'),
      ),
    )
  })

  it('says it fits none when it is far from all of them', () => {
    const issues = run({ wings: true })
    expect(issues[0]).toMatchObject({ path: '(root)', message: 'matches none of: Money | Range' })
    expect(issues.length).toBeLessThanOrEqual(3)
  })

  it('keeps going on a long list of them without trying every variant of every item', () => {
    const many = Array.from({ length: 400 }, () => ({ low: 1, high: 2 }))
    const list = { type: 'array', items: price }
    const issues = validate(many, list, untagged, { reportExtra: true })
    expect(Array.isArray(issues)).toBe(true)
    // the first items are still judged properly
    expect(issues.filter((i) => i.path.startsWith('[0]'))).toEqual([])
  })
})

describe('how a union is shown', () => {
  it('names its variants in the type column instead of "object"', () => {
    const items = defs.$defs.Shelf.properties.items
    expect(typeInfo(items, defs).text).toBe('(Book | Album | Zine)[]')
    expect(typeInfo(conflict, defs).text).toBe('OutOfStock | Discontinued')
    expect(typeInfo({ type: 'integer', format: 'int32' }, defs).text).toBe('integer · int32')
  })

  it('counts the variants past the first few, with all of them as the title', () => {
    const many = {
      oneOf: ['A', 'B', 'C', 'D', 'E'].map((n) => ({
        title: n,
        type: 'object',
        properties: { n: { type: 'string' } },
      })),
    }
    expect(typeInfo(many, defs)).toEqual({
      text: 'A | B | C | +2 more',
      title: 'A | B | C | D | E',
    })
  })

  it('lists each variant’s fields under a heading that names it and its tag', () => {
    const rows = flatten(shelf, defs).map((r) =>
      `${'  '.repeat(r.depth)}${r.variant ? '— ' : ''}${r.name.split('.').pop()} ${r.type}`.trimEnd(),
    )
    expect(rows).toEqual([
      'name string',
      'items (Book | Album | Zine)[]',
      '  — Book kind = "book"',
      '    kind string',
      '    title string',
      '    pages integer',
      '    related object[]',
      '      kind string',
      '      title string',
      '      tracks integer',
      '  — Album kind = "album"',
      '    kind string',
      '    title string',
      '    tracks integer',
      '  — Zine kind = "Zine"',
      '    kind string',
      '    title string',
      '    issue integer',
    ])
  })
})

describe('the field a cursor is on, in a list of variants', () => {
  const body = at([book, album])

  it('is looked up in the variant the item names', () => {
    expect(fieldDoc(shelf, defs, ['items', 1, 'tracks'], [], body)?.type).toBe('integer')
    expect(fieldDoc(shelf, defs, ['items', 0, 'pages'], [], body)?.type).toBe('integer')
  })

  it('finds nothing for a field the item’s variant does not have', () => {
    expect(fieldDoc(shelf, defs, ['items', 0, 'tracks'], [], body)).toBeUndefined()
  })

  it('says what a union is when the cursor is on an item', () => {
    expect(fieldDoc(shelf, defs, ['items'], [], body)?.type).toBe('(Book | Album | Zine)[]')
  })
})

describe('completing inside a list of variants', () => {
  const here = (text: string) => {
    const pos = text.indexOf('|')
    return jsonCompletions(shelf, defs, [], text.replace('|', ''), pos)
  }
  const labels = (text: string) => here(text)?.options.map((o) => o.label)

  it('records what an object already has, and what is above it', () => {
    const text = '{"name": "Main", "items": [{"kind": "album", "ti'
    const c = jsonCursor(text, text.length)
    expect(c?.values).toEqual({ kind: 'album' })
    expect(c?.skeleton).toEqual({ name: 'Main', items: [{ kind: 'album' }] })
  })

  it('offers the variants’ tags for the property that tells them apart', () => {
    const c = here('{"items": [{"kind": "|')
    expect(c?.options.map((o) => [o.label, o.detail])).toEqual([
      ['book', 'Book'],
      ['album', 'Album'],
      ['Zine', 'Zine'],
    ])
  })

  it('offers only the fields of the variant the item names', () => {
    expect(labels('{"items": [{"kind": "album", "|')).toEqual(['title', 'tracks'])
    expect(labels('{"items": [{"kind": "book", "|')).toEqual(['title', 'pages', 'related'])
  })

  it('follows the tag on the way down, too', () => {
    // a book's `related` holds albums, which have `tracks`
    expect(labels('{"items": [{"kind": "book", "related": [{"|')).toEqual([
      'kind',
      'title',
      'tracks',
    ])
  })

  it('offers every variant’s fields before there is a tag, saying whose they are, tag first', () => {
    const c = here('{"items": [{"|')
    const byLabel = Object.fromEntries((c?.options ?? []).map((o) => [o.label, o]))
    expect(Object.keys(byLabel).sort()).toEqual([
      'issue',
      'kind',
      'pages',
      'related',
      'title',
      'tracks',
    ])
    expect(byLabel.pages?.detail).toBe('integer · Book')
    expect(byLabel.title?.detail).toBe('string')
    expect((byLabel.kind?.boost ?? 0) > (byLabel.title?.boost ?? 0)).toBe(true)
  })

  it('leaves a request body whose schema has no union as it was', () => {
    const plain = { type: 'object', properties: { name: { type: 'string' } } }
    expect(jsonCompletions(plain, defs, [], '{"', 2)?.options.map((o) => o.label)).toEqual(['name'])
  })
})
