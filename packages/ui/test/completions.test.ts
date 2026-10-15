import { describe, expect, it } from 'vitest'
import { jsonCompletions } from '../src/panel/completions'
import { jsonCursor } from '../src/panel/jsonCursor'

const at = (text: string) => {
  const pos = text.indexOf('|')
  return { text: text.replace('|', ''), pos }
}

describe('jsonCursor', () => {
  it('knows when a key is being written and what the object already has', () => {
    const { text, pos } = at('{ "name": "x", "ad|" }')
    const c = jsonCursor(text, pos)
    expect(c).toMatchObject({ mode: 'key', path: [], inString: true, prefix: 'ad' })
    expect([...(c?.existing ?? [])]).toEqual(['name'])
  })

  it('finds the path into nested objects and arrays', () => {
    const { text, pos } = at('{ "items": [ { "price": "a" }, { "qty|" } ] }')
    expect(jsonCursor(text, pos)).toMatchObject({ mode: 'key', path: ['items', 1] })
    const v = at('{ "items": [ { "price": |')
    expect(jsonCursor(v.text, v.pos)).toMatchObject({ mode: 'value', path: ['items', 0, 'price'] })
  })

  it('treats the position after a colon as a value, and a bare position in an object as a key', () => {
    const a = at('{ "status": "av|" }')
    expect(jsonCursor(a.text, a.pos)).toMatchObject({
      mode: 'value',
      path: ['status'],
      prefix: 'av',
    })
    const b = at('{ "a": 1, |')
    expect(jsonCursor(b.text, b.pos)).toMatchObject({ mode: 'key', path: [] })
  })

  it('reports an existing colon so only the key is replaced', () => {
    const { text, pos } = at('{ "na|me": 1 }')
    expect(jsonCursor(text, pos)).toMatchObject({ hasColon: true, from: 2, to: 8 })
  })
})

describe('jsonCompletions', () => {
  const request = {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        required: ['currency'],
        properties: {
          currency: {
            type: 'string',
            description: 'Three-letter [ISO code](https://example.test/iso), in `lowercase`.',
          },
          amount: { type: 'integer' },
          status: { type: 'string', enum: ['open', 'paid'] },
          paid: { type: 'boolean' },
          address: { type: 'object', properties: { city: { type: 'string' } } },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }
  const run = (marked: string) => {
    const { text, pos } = at(marked)
    return jsonCompletions(request, undefined, ['data'], text, pos)
  }

  it('offers the properties not yet present, required first, with skeleton values', () => {
    const r = run('{ "amount": 1, "|" }')
    const labels = r?.options.map((o) => o.label)
    expect(labels).toEqual(
      expect.arrayContaining(['currency', 'status', 'paid', 'address', 'tags']),
    )
    expect(labels).not.toContain('amount')
    const currency = r?.options.find((o) => o.label === 'currency')
    expect(currency).toMatchObject({
      detail: 'string · required',
      insert: '"currency": ""',
      boost: 10,
    })
    const address = r?.options.find((o) => o.label === 'address')
    expect(address?.insert).toBe('"address": {}')
    expect(address?.tabStops).toEqual([12])
  })

  it('offers nested properties inside a nested object', () => {
    const r = run('{ "address": { "|" } }')
    expect(r?.options.map((o) => o.label)).toEqual(['city'])
  })

  it('offers enum values and booleans for a value, and nothing for free text', () => {
    expect(run('{ "status": "|" }')?.options.map((o) => o.label)).toEqual(['open', 'paid'])
    expect(run('{ "paid": | }')?.options.map((o) => o.insert)).toEqual(['true', 'false'])
    expect(run('{ "currency": "|" }')).toBeUndefined()
  })

  it('only replaces the key when a colon already follows', () => {
    const r = run('{ "am|": 5 }')
    expect(r?.options.find((o) => o.label === 'amount')?.insert).toBe('"amount"')
  })
})
