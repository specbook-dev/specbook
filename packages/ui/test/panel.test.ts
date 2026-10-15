import { describe, expect, it } from 'vitest'
import { fieldDoc, keyPath, withNote } from '../src/fielddoc'
import { draftFrom, previewUrl, requestParts } from '../src/panel/draft'
import { noteKey, splitFieldNotes } from '../src/panel/fieldnotes-split'
import { joinGraphql, splitGraphql } from '../src/panel/graphql'
import { parsePasted } from '../src/panel/ParamGrid'
import { splitStepNotes } from '../src/panel/stepnotes-split'

const defs = {
  $defs: {
    Pet: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'display name' },
        status: { type: 'string', enum: ['available', 'sold'], description: 'pet status' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
}
const request = { type: 'object', properties: { data: { $ref: '#/$defs/Pet' } } }

describe('fieldDoc', () => {
  it('describes a body field relative to the request schema', () => {
    expect(fieldDoc(request, defs, ['name'], ['data'])).toMatchObject({
      path: 'name',
      type: 'string',
      required: true,
      description: 'display name',
    })
    expect(fieldDoc(request, defs, ['status'], ['data'])).toMatchObject({
      required: false,
      enum: ['available', 'sold'],
    })
    expect(fieldDoc(request, defs, ['tags'], ['data'])?.type).toBe('string[]')
  })

  it('is undefined for unknown fields and for a root the spec does not describe', () => {
    expect(fieldDoc(request, defs, ['nope'], ['data'])).toBeUndefined()
    expect(fieldDoc(request, defs, [])).toBeUndefined()
    expect(fieldDoc(request, defs, [], ['data'])).toBeUndefined()
  })

  it('describes the whole body from the schema description, with its title', () => {
    const issue = {
      title: 'Issue',
      description: 'Issues are a great way to keep track of tasks.',
      type: 'object',
      properties: { title: { type: 'string' } },
    }
    expect(fieldDoc(issue, {}, [])).toMatchObject({
      path: 'Issue',
      type: 'object',
      required: false,
      description: 'Issues are a great way to keep track of tasks.',
    })
    const wrapped = { type: 'object', properties: { data: issue } }
    expect(fieldDoc(wrapped, {}, [], ['data'])?.description).toContain('great way')
  })

  it('reads bracket keys as paths', () => {
    expect(keyPath('items[0][price]')).toEqual(['items', 0, 'price'])
  })
})

describe('draft', () => {
  const example = {
    name: 'e',
    source: 'generated' as const,
    path: { id: '7' },
    query: { tag: ['a', 'b'] },
    body: { name: 'Rex', meta: { k: 'v' } },
  }

  it('turns an example into editable rows and back into request parts', () => {
    const d = draftFrom(example, 'json')
    expect(d.query).toHaveLength(2)
    const parts = requestParts(d, 'json')
    expect(parts).toEqual({
      path: { id: '7' },
      query: { tag: ['a', 'b'] },
      headers: undefined,
      data: example.body,
    })
  })

  it('drops unchecked rows and keeps form bodies as bracket-key rows', () => {
    const d = draftFrom(example, 'form')
    expect(d.fields.map((f) => f.key)).toEqual(['name', 'meta[k]'])
    const off = { ...d, query: d.query.map((r, i) => ({ ...r, enabled: i !== 1 })) }
    expect(requestParts(off, 'form').query).toEqual({ tag: 'a' })
    expect(requestParts(d, 'form').data).toEqual({ name: 'Rex', meta: { k: 'v' } })
  })

  it('explains invalid JSON', () => {
    expect(() => requestParts({ ...draftFrom(example, 'json'), body: '{ "a": ' }, 'json')).toThrow(
      /Invalid JSON/,
    )
  })
})

describe('graphql body', () => {
  const body = JSON.stringify({ query: '{ pet { id } }', variables: { id: 1 }, operationName: 'Q' })

  it('splits into query and variables and joins back', () => {
    const g = splitGraphql(body)
    expect(g?.query).toBe('{ pet { id } }')
    expect(JSON.parse(g?.variables ?? '')).toEqual({ id: 1 })
    expect(JSON.parse(joinGraphql(g as never))).toEqual(JSON.parse(body))
  })

  it('keeps variables typed so far and drops empty ones', () => {
    const g = splitGraphql(body) as NonNullable<ReturnType<typeof splitGraphql>>
    expect(JSON.parse(joinGraphql({ ...g, variables: '{"id":' })).variables).toBe('{"id":')
    expect('variables' in JSON.parse(joinGraphql({ ...g, variables: '  ' }))).toBe(false)
  })

  it('does not split what is not a graphql object', () => {
    expect(splitGraphql('not json')).toBeUndefined()
    expect(splitGraphql('{"x":1}')).toBeUndefined()
  })
})

describe('url preview', () => {
  const row = (key: string, value: string, enabled = true) => ({ key, value, enabled })
  it('fills path parameters and appends only the enabled query rows, repeated keys included', () => {
    expect(
      previewUrl(
        '/pet/{petId}/photos',
        [row('petId', '7')],
        [
          row('status', 'sold'),
          row('status', 'pending', false),
          row('status', 'available'),
          row('', 'x'),
        ],
        'https://api.test/v3/',
      ),
    ).toBe('https://api.test/v3/pet/7/photos?status=sold&status=available')
  })
  it('keeps unfilled parameters and placeholders readable', () => {
    expect(previewUrl('/o/{id}', [row('id', '')], [row('q', '{{term}}')])).toBe(
      '/o/{id}?q={{term}}',
    )
  })
})

describe('pasting rows', () => {
  it('reads key=value, key: value and tab separated lines', () => {
    expect(parsePasted('a=1\nb: two\nc\tthree\nlone\n')).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: 'two' },
      { key: 'c', value: 'three' },
      { key: 'lone', value: '' },
    ])
  })
})

describe('splitStepNotes', () => {
  const html =
    '<p>intro</p><h2>Place order</h2><p>uses the pet</p><h2>Notes</h2><p>other</p><h2>verify ORDER</h2><p>checks it</p>'

  it('attaches a section to the step its heading names and keeps other headings', () => {
    const { intro, notes } = splitStepNotes(html, ['Find pets', 'Place order', 'Verify order'])
    expect(intro).toBe('<p>intro</p><h2>Notes</h2><p>other</p>')
    expect([...notes.keys()]).toEqual(['Place order', 'Verify order'])
    expect(notes.get('Place order')).toBe('<p>uses the pet</p>')
  })

  it('leaves the page alone when no step is named', () => {
    expect(splitStepNotes(html, ['Other']).intro).toBe(html)
  })
})

describe('field notes', () => {
  const html =
    '<p>Intro.</p><h2>Notes</h2><p>kept</p><h2><code>name</code></h2><p>short names</p>' +
    '<h3><code>query.status</code></h3><p>pending is sandbox only</p>' +
    '<h2><code>data.items[0].price</code></h2><p>in cents</p>'

  it('attaches text under a code heading to the field, and keeps the rest as intro', () => {
    const { intro, notes } = splitFieldNotes(html)
    expect(intro).toBe('<p>Intro.</p><h2>Notes</h2><p>kept</p>')
    expect(notes.get('data.name')).toBe('<p>short names</p>')
    expect(notes.get('query.status')).toBe('<p>pending is sandbox only</p>')
    // array indexes are ignored: `items[0].price` is `items.price`
    expect(notes.get('data.items.price')).toBe('<p>in cents</p>')
  })

  it('looks fields up the same way the editor names them', () => {
    expect(noteKey('data', 'items[2].price')).toBe('data.items.price')
    expect(noteKey('query', 'status')).toBe('query.status')
  })

  it('adds a note to a field doc only when one exists', () => {
    const notes = new Map([['data.name', '<p>n</p>']])
    const doc = fieldDoc(request, defs, ['name'], ['data'])
    expect(withNote(doc, notes, 'data', 'name')?.note).toBe('<p>n</p>')
    expect(withNote(doc, notes, 'data', 'status')?.note).toBeUndefined()
    expect(withNote(undefined, notes, 'data', 'name')).toBeUndefined()
  })
})
