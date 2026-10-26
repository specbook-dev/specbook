import { describe, expect, it } from 'vitest'
import {
  createMockTransport,
  defineOperation,
  runRequest,
  runSequence,
  sequence,
  withMock,
} from '../src/internal'

const GetOrder = defineOperation<{
  params: { path: { id: string } }
  body: never
  responses: {
    200: { id: string; owner: string; status: string }
    404: { message: string }
    401: { message: string }
  }
}>({ service: 'order', id: 'GetOrder', method: 'GET', path: '/orders/{id}', security: true })

const loader = {
  statuses: () => [200, 404, 401],
  example: (_s: string, _o: string, status: number) =>
    status === 200
      ? { id: '{{id}}', owner: 'default', status: 'approved' }
      : { message: `status ${status}` },
}
const transport = createMockTransport({ loader, sleep: async () => {} })
const base = {
  env: 'mock',
  transport,
  auth: { k: { apply: { headers: { authorization: 'Bearer x' } } } },
  serviceAuth: { order: 'k' },
}
const body = (r: Awaited<ReturnType<typeof runRequest>>) => r.steps[0]?.response?.body

describe('mock transport', () => {
  it('serves the example and renders path vars', async () => {
    const r = await runRequest(GetOrder.request({ path: { id: 'o-7' } }), base)
    expect(body(r)).toEqual({ id: 'o-7', owner: 'default', status: 'approved' })
  })
  it('the run option forces a declared status, for every request in the run', async () => {
    const r = await runRequest(GetOrder.request({ path: { id: 'x' } }), {
      ...base,
      mockStatus: 404,
    })
    expect(r.steps[0]?.response?.status).toBe(404)
  })
  it('secured op without credentials answers 401', async () => {
    const r = await runRequest(GetOrder.request({ path: { id: 'x' } }), { env: 'mock', transport })
    expect(r.steps[0]?.response?.status).toBe(401)
  })
  it('a profile that sends its credential in a query value is credentials enough', async () => {
    const r = await runRequest(GetOrder.request({ path: { id: 'x' } }), {
      env: 'mock',
      transport,
      auth: { q: { apply: { query: { token: 'x' } } } },
      serviceAuth: { order: 'q' },
    })
    expect(r.steps[0]?.response?.status).toBe(200)
  })
  it('so is a profile that sends it in a header the mock would not recognize', async () => {
    const r = await runRequest(GetOrder.request({ path: { id: 'x' } }), {
      env: 'mock',
      transport,
      auth: { p: { apply: { headers: { 'X-Partner': 'acme' } } } },
      serviceAuth: { order: 'p' },
    })
    expect(r.steps[0]?.response?.status).toBe(200)
  })
  it('without a profile, a header of an unrecognized name does not count as credentials', async () => {
    const r = await runRequest(
      GetOrder.request({ path: { id: 'x' }, headers: { 'X-Partner': 'acme' } }),
      { env: 'mock', transport },
    )
    expect(r.steps[0]?.response?.status).toBe(401)
  })
  it('a credential in a header named for a secret or a client id counts as one', async () => {
    const r = await runRequest(
      GetOrder.request({
        path: { id: 'x' },
        headers: { 'PLAID-CLIENT-ID': 'c', 'PLAID-SECRET': 's' },
      }),
      { env: 'mock', transport },
    )
    expect(r.steps[0]?.response?.status).toBe(200)
  })
  it('does not touch the example the loader hands out', async () => {
    const shared = { id: 'a', owner: 'shared', status: 'approved' }
    const t = createMockTransport({ loader: { statuses: () => [200], example: () => shared } })
    const def = withMock(GetOrder.request({ path: { id: 'a' } }), (_req, res) => {
      if (res.status === 200) res.data.owner = 'changed'
    })
    await runRequest(def, { ...base, transport: t })
    expect(shared.owner).toBe('shared')
  })
})

describe('a status whose example file holds variants', () => {
  const conflict = {
    $variants: [
      { name: 'OutOfStock', body: { message: 'out of stock', sku: '{{id}}' } },
      { name: 'Discontinued', body: { message: 'discontinued' } },
    ],
  }
  const plain = { id: '{{id}}', owner: 'default', status: 'approved' }
  const many = createMockTransport({
    loader: {
      statuses: () => [200, 404, 401],
      example: (_s: string, _o: string, status: number) =>
        status === 404
          ? conflict
          : status === 401
            ? {
                $variants: [
                  { name: 'A', body: { message: 'a' } },
                  { name: 'B', body: { message: 'b' } },
                ],
              }
            : plain,
    },
    sleep: async () => {},
  })
  const run = (def: Parameters<typeof runRequest>[0], o: object = {}) =>
    runRequest(def, { ...base, transport: many, ...o })
  const get = GetOrder.request({ path: { id: 'o-1' } })

  it('answers a bare body as before, and a forced status with its first variant', async () => {
    expect(body(await run(get))).toEqual({ id: 'o-1', owner: 'default', status: 'approved' })
    const r = await run(get, { mockStatus: 404 })
    expect(r.steps[0]?.response?.status).toBe(404)
    expect(body(r)).toEqual({ message: 'out of stock', sku: 'o-1' })
  })

  it('answers the variant that was asked for, for the status that was forced', async () => {
    const r = await run(get, { mockStatus: 404, mockVariant: 'Discontinued' })
    expect(body(r)).toEqual({ message: 'discontinued' })
    // a name the file does not have answers the first
    expect(body(await run(get, { mockStatus: 404, mockVariant: 'Nope' }))).toEqual({
      message: 'out of stock',
      sku: 'o-1',
    })
  })

  it('does not apply a variant to a status that was not forced', async () => {
    expect(body(await run(get, { mockVariant: 'Discontinued' }))).toEqual({
      id: 'o-1',
      owner: 'default',
      status: 'approved',
    })
  })

  it('unwraps the 401 a secured operation answers without credentials', async () => {
    const r = await runRequest(get, { env: 'mock', transport: many })
    expect(r.steps[0]?.response?.status).toBe(401)
    expect(body(r)).toEqual({ message: 'a' })
  })

  it('lets a hook respond with a variant, with its data merged over it', async () => {
    const def = withMock(get, (_req, res) => {
      res.respond(404, { message: 'only two left' }, 'OutOfStock')
    })
    expect(body(await run(def))).toEqual({ message: 'only two left', sku: 'o-1' })
    // the variant it does not name keeps its own fields out of the answer
    const other = withMock(get, (_req, res) => {
      res.respond(404, undefined, 'Discontinued')
    })
    expect(body(await run(other))).toEqual({ message: 'discontinued' })
  })

  it('still echoes the request into a 2xx variant', async () => {
    const t = createMockTransport({
      loader: {
        statuses: () => [200],
        example: () => ({
          $variants: [
            { name: 'First', body: { id: 'x', owner: 'one', status: 'a' } },
            { name: 'Second', body: { id: 'x', owner: 'two', status: 'b' } },
          ],
        }),
      },
    })
    const r = await runRequest(GetOrder.request({ path: { id: 'o-5' } }), {
      ...base,
      transport: t,
      mockStatus: 200,
      mockVariant: 'Second',
    })
    expect(body(r)).toEqual({ id: 'o-5', owner: 'two', status: 'b' })
  })
})

describe('withMock', () => {
  it('changes what the example says, typed to the operation', async () => {
    const def = withMock(GetOrder.request({ path: { id: 'o-9' } }), (_req, res) => {
      if (res.status === 200) {
        res.data.owner = 'Grace'
        res.data.status = 'placed'
      }
    })
    const r = await runRequest(def, base)
    expect(body(r)).toEqual({ id: 'o-9', owner: 'Grace', status: 'placed' })
  })

  it('decides from the request: values sent, vars and the path', async () => {
    const def = withMock(
      GetOrder.request({ path: { id: 'missing' }, init: { who: () => 'Ada' } }),
      (req, res) => {
        if ((req.path as { id: string }).id === 'missing')
          res.respond(404, { message: 'no such order' })
        else if (res.status === 200) res.data.owner = String(req.vars.who)
      },
    )
    const r = await runRequest(def, base)
    expect(r.steps[0]?.response?.status).toBe(404)
    expect(body(r)).toEqual({ message: 'no such order' })
    const ok = await runRequest(
      withMock(
        GetOrder.request({ path: { id: 'o-1' }, init: { who: () => 'Ada' } }),
        (req, res) => {
          if (res.status === 200) res.data.owner = String(req.vars.who)
        },
      ),
      base,
    )
    expect(body(ok)).toMatchObject({ owner: 'Ada' })
  })

  it('sets headers and waits the delay it asks for', async () => {
    const waited: number[] = []
    const t = createMockTransport({ loader, sleep: async (ms) => void waited.push(ms) })
    const def = withMock(GetOrder.request({ path: { id: 'x' } }), (_req, res) => {
      res.headers['x-rate-limit'] = '9'
      res.delayMs = 800
    })
    const r = await runRequest(def, { ...base, transport: t })
    expect(r.steps[0]?.response?.headers['x-rate-limit']).toBe('9')
    expect(waited).toEqual([800])
  })

  it('may be async', async () => {
    const def = withMock(GetOrder.request({ path: { id: 'x' } }), async (_req, res) => {
      await Promise.resolve()
      if (res.status === 200) res.data.owner = 'later'
    })
    expect(body(await runRequest(def, base))).toMatchObject({ owner: 'later' })
  })

  it('is carried by .with(), and by a request used as a flow step', async () => {
    const def = withMock(GetOrder.request({ path: { id: 'x' } }), (_req, res) => {
      if (res.status === 200) res.data.status = 'placed'
    }).with({ tags: ['smoke'] })
    expect(body(await runRequest(def, base))).toMatchObject({ status: 'placed' })

    const flow = sequence({ id: 'f', title: 'F' }).step('Get', def)
    const r = await runSequence(flow, base)
    expect(r.steps[0]?.response?.body).toMatchObject({ status: 'placed' })
  })

  it('answers with an empty body for a declared status that has no example', async () => {
    const t = createMockTransport({
      loader: {
        statuses: () => [200, 404],
        example: (_s, _o, st) => (st === 200 ? { id: 'x' } : undefined),
      },
    })
    const r = await runRequest(GetOrder.request({ path: { id: 'x' } }), {
      env: 'mock',
      transport: t,
      mockStatus: 404,
    })
    expect(r.steps[0]?.response?.status).toBe(404)
    expect(r.steps[0]?.error).toBeUndefined()
  })
})
