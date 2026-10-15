import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import {
  c,
  collectSecretNames,
  defineOperation,
  encodeBody,
  fromFormRows,
  fromRows,
  render,
  runRequest,
  runSequence,
  sequence,
  setFaker,
  toFormRows,
  toRows,
  usesFaker,
} from '../src'
import { formatPretty } from '../src/reporters'
import { fakeTransport } from './helpers'

const Create = defineOperation<{
  params: {}
  body: { name: string; qty: number | string }
  responses: { 200: { id: string; name: string } }
}>({ service: 'shop', id: 'Create', method: 'POST', path: '/orders' })

const Get = defineOperation<{
  params: { path: { id: string } }
  body: never
  responses: { 200: { id: string; name: string } }
}>({ service: 'shop', id: 'Get', method: 'GET', path: '/orders/{id}' })

const api = () =>
  fakeTransport((req) =>
    req.method === 'POST'
      ? { body: { id: 'o1', name: (req.body as any).name } }
      : { body: { id: req.url.split('/').pop(), name: 'x' } },
  )

const create = Create.request({
  init: { n: 'Rex' },
  data: { name: '{{n}}', qty: 1 },
  capture: { orderId: (res) => res.data.id },
})
const get = Get.request({ init: { orderId: 'fallback' }, path: { id: '{{orderId}}' } })

afterEach(() => setFaker(undefined))

describe('captures are variables', () => {
  it('feed later steps without forwarding', async () => {
    const { transport, calls } = api()
    const seq = sequence({ id: 's', title: 'S' }).step('create', create).step('get', get)
    const r = await runSequence(seq, { env: 'mock', transport })
    expect(r.status).toBe('pass')
    expect(calls[1]?.url).toBe('/orders/o1')
    expect(r.steps[1]?.uses).toContainEqual({ key: 'orderId', source: 'capture', step: 'create' })
  })

  it('flags a capture that replaces a value of another type', async () => {
    const { transport } = api()
    const typed = Get.request({ init: { orderId: 7 }, path: { id: '{{orderId}}' } })
    const r = await runSequence(
      sequence({ id: 's', title: 'S' }).step('create', create).step('get', typed),
      { env: 'mock', transport },
    )
    expect(r.steps[1]?.uses).toContainEqual({
      key: 'orderId',
      source: 'capture',
      step: 'create',
      shadows: { source: 'init', type: 'number', replacedBy: 'string' },
    })
    expect(formatPretty([r])).toContain('⚠ orderId')
  })

  it('writes form arrays in the style the spec asks for, per field', () => {
    const body = { ids: [1, 2], tags: ['a', 'b'], expand: ['x'], meta: { k: 'v' } }
    const form = encodeBody('form', body, { ids: 'repeat', tags: 'comma' }).body as string
    expect(decodeURIComponent(form)).toBe('ids=1&ids=2&tags=a,b&expand[0]=x&meta[k]=v')
    expect(
      decodeURIComponent(encodeBody('form', { a: ['x', 'y'] }, 'brackets').body as string),
    ).toBe('a[]=x&a[]=y')
    expect(
      decodeURIComponent(encodeBody('form', { a: ['x', 'y'] }, { a: 'pipe' }).body as string),
    ).toBe('a=x|y')
  })

  it('sends a binary body as the spec declares, not as the file calls itself', () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
    // declared application/octet-stream: the server answers 415 to image/png
    expect(encodeBody('binary', png, undefined, 'application/octet-stream').contentType).toBe(
      'application/octet-stream',
    )
    // nothing declared: the file's own type, then octet-stream
    expect(encodeBody('binary', png).contentType).toBe('image/png')
    expect(encodeBody('binary', new Blob(['x'])).contentType).toBe('application/octet-stream')
  })

  it('finds secrets that only appear in the example file', async () => {
    const withExample = Create.request({ example: 'vip' })
    const loader = async () => ({
      name: 'vip',
      source: 'project' as const,
      headers: { authorization: 'Bearer {{secrets.TOKEN}}' },
      body: { name: 'Rex', qty: 1 },
    })
    expect([...(await collectSecretNames(withExample))]).toEqual([])
    expect([...(await collectSecretNames(withExample, {}, loader))]).toEqual(['TOKEN'])
  })

  it('only scans the auth profiles a run can use', async () => {
    const auth = {
      mine: { apply: { headers: { authorization: '{{secrets.MINE}}' } } },
      other: { apply: { headers: { authorization: '{{secrets.OTHER}}' } } },
    } as never
    const used = await collectSecretNames(Create.request({}), auth, undefined, { shop: 'mine' })
    expect([...used]).toEqual(['MINE'])
    expect([...(await collectSecretNames(Create.request({}), auth))].sort()).toEqual([
      'MINE',
      'OTHER',
    ])
  })

  it('a request played alone uses its init', async () => {
    const { transport, calls } = api()
    await runRequest(get, { env: 'mock', transport })
    expect(calls[0]?.url).toBe('/orders/fallback')
  })

  it('.with({ vars }) beats a capture, and params beat init', async () => {
    const { transport, calls } = api()
    const pinned = get.with({ vars: { orderId: 'pinned' } })
    await runSequence(
      sequence({ id: 's', title: 'S' }).step('create', create).step('get', pinned),
      {
        env: 'mock',
        transport,
      },
    )
    expect(calls[1]?.url).toBe('/orders/pinned')

    const named = Create.request({ init: { n: 'init' }, data: { name: '{{n}}', qty: 1 } })
    const seq = sequence({ id: 'p', title: 'P', params: { n: c.text({ default: 'param' }) } }).step(
      'named',
      named,
    )
    const r = await runSequence(seq, { env: 'mock', transport })
    expect(calls[2]?.body).toMatchObject({ name: 'param' })
    expect(r.steps[0]?.uses).toContainEqual({ key: 'n', source: 'param' })
  })

  it('assert sees captures in vars and the request that was sent in req', async () => {
    const { transport } = api()
    let seen: any
    const def = Create.request({
      init: { n: 'Rex' },
      data: { name: '{{n}}', qty: 1 },
      capture: { orderId: (res) => res.data.id },
      assert: (_res, { vars, req }) => {
        seen = { orderId: vars.orderId, n: vars.n, body: req.body, url: req.url }
        expectTypeOf(vars.orderId).toEqualTypeOf<string>()
        expectTypeOf(vars.n).toEqualTypeOf<string>()
      },
    })
    await runRequest(def, { env: 'mock', transport })
    expect(seen).toEqual({
      orderId: 'o1',
      n: 'Rex',
      body: { name: 'Rex', qty: 1 },
      url: '/orders',
    })
  })
})

describe('faker namespace', () => {
  it('calls the generator fresh on each render and keeps whole-string types', () => {
    let n = 0
    setFaker({ person: { firstName: () => `Rex${++n}` }, number: { int: () => 42 } })
    expect(render('{{faker.person.firstName}}', {})).toBe('Rex1')
    expect(render('{{faker.person.firstName}}', {})).toBe('Rex2')
    expect(render('{{faker.number.int}}', {})).toBe(42)
    expect(render('hi {{faker.person.firstName}}', {})).toBe('hi Rex3')
  })

  it('is detected so faker only loads when used', () => {
    expect(usesFaker({ a: ['{{faker.internet.email}}'] })).toBe(true)
    expect(usesFaker({ a: '{{name}}', b: '{{secrets.K}}' })).toBe(false)
  })
})

describe('examples', () => {
  it('start the request; its own fields merge over them', async () => {
    const { transport, calls } = api()
    const def = Create.request({
      example: 'rex',
      data: { qty: 5 } as any,
      init: { who: 'Fido' },
    })
    await runRequest(def, {
      env: 'mock',
      transport,
      example: async (_op, name) =>
        name === 'rex'
          ? { name, source: 'project', body: { name: '{{who}}', qty: 1 }, headers: { 'x-a': '1' } }
          : undefined,
    })
    expect(calls[0]?.body).toEqual({ name: 'Fido', qty: 5 })
    expect(calls[0]?.headers['x-a']).toBe('1')
  })

  it('fails clearly when the example is missing', async () => {
    const { transport } = api()
    const r = await runRequest(Create.request({ example: 'nope' }), { env: 'mock', transport })
    expect(r.status).toBe('error')
    expect(r.steps[0]?.error).toMatch(/Example "nope" not found/)
  })

  it('round-trips grid rows: repeated keys, disabled rows dropped', () => {
    const rows = toRows({ tag: ['a', 'b'], limit: 10 })
    expect(rows).toEqual([
      { key: 'tag', value: 'a', enabled: true },
      { key: 'tag', value: 'b', enabled: true },
      { key: 'limit', value: '10', enabled: true },
    ])
    const off = rows.map((r, i) => ({ ...r, enabled: i !== 1 }))
    expect(fromRows(off)).toEqual({ tag: 'a', limit: '10' })
    expect(fromRows(rows)).toEqual({ tag: ['a', 'b'], limit: '10' })
  })
})

describe('body encodings', () => {
  it('form: brackets for objects, indices or repeats for arrays', () => {
    const body = { metadata: { order: '1' }, expand: ['a', 'b'] }
    expect(decodeURIComponent(encodeBody('form', body).body as string)).toBe(
      'metadata[order]=1&expand[0]=a&expand[1]=b',
    )
  })

  it('graphql: sent as JSON, a bare string is the query', () => {
    expect(encodeBody('graphql', { query: '{ a }', variables: { id: 1 } })).toEqual({
      body: '{"query":"{ a }","variables":{"id":1}}',
      contentType: 'application/json',
    })
    expect(encodeBody('graphql', '{ a }').body).toBe('{"query":"{ a }"}')
  })

  it('multipart: text, repeated, JSON and file parts; boundary left to fetch', () => {
    const file = new File(['hi'], 'a.txt', { type: 'text/plain' })
    const enc = encodeBody('multipart', { name: 'x', tag: ['a', 'b'], meta: { k: 1 }, file })
    const fd = enc.body as FormData
    expect(enc.contentType).toBeUndefined()
    expect(fd.getAll('tag')).toEqual(['a', 'b'])
    expect((fd.get('file') as File).name).toBe('a.txt')
    expect((fd.get('meta') as Blob).type).toBe('application/json')
  })

  it('upload fields are read from disk-like storage and only described in results', async () => {
    const Upload = defineOperation<{
      params: {}
      body: { name: string; photo: string }
      responses: { 200: {} }
    }>({
      service: 'shop',
      id: 'Upload',
      method: 'POST',
      path: '/up',
      encoding: 'multipart',
      files: ['photo'],
    })
    const { transport, calls } = fakeTransport(() => ({ body: {} }))
    const read: string[] = []
    const r = await runRequest(Upload.request({ example: 'e' }), {
      env: 'mock',
      transport,
      example: async () => ({
        name: 'e',
        source: 'project',
        dir: '/ex',
        body: { name: 'cat', photo: './cat.png' },
      }),
      readFile: async (path, dir) => {
        read.push(`${dir}:${path}`)
        return new File(['png'], 'cat.png', { type: 'image/png' })
      },
    })
    expect(read).toEqual(['/ex:./cat.png'])
    expect(calls[0]?.body).toMatchObject({ photo: expect.any(Blob) })
    expect(r.steps[0]?.request?.body).toEqual({
      name: 'cat',
      photo: { file: 'cat.png', type: 'image/png', size: 3 },
    })
  })
})

describe('form rows', () => {
  it('flattens nested bodies to bracket keys and back', () => {
    const body = { name: 'a', metadata: { order: '1' }, items: [{ price: 'p1' }, { price: 'p2' }] }
    const rows = toFormRows(body)
    expect(rows.map((r) => r.key)).toEqual([
      'name',
      'metadata[order]',
      'items[0][price]',
      'items[1][price]',
    ])
    expect(fromFormRows(rows)).toEqual(body)
  })

  it('handles [] pushes, repeats and disabled rows; keeps files', () => {
    const file = new File(['x'], 'a.txt')
    const out = fromFormRows([
      { key: 'expand[]', value: 'a', enabled: true },
      { key: 'expand[]', value: 'b', enabled: true },
      { key: 'tag', value: '1', enabled: true },
      { key: 'tag', value: '2', enabled: true },
      { key: 'off', value: 'x', enabled: false },
      { key: 'photo', value: './a.txt', enabled: true, file },
    ])
    expect(out).toEqual({ expand: ['a', 'b'], tag: ['1', '2'], photo: file })
  })

  it('rendering keeps files intact', () => {
    const file = new File(['x'], 'a.txt')
    expect(render({ photo: file }, {}).photo).toBe(file)
  })
})
