import { describe, expect, it } from 'vitest'
import { createMockTransport, defineOperation, runRequest } from '../src'

const GetOrder = defineOperation<{
  params: { path: { id: string } }
  body: never
  responses: {
    200: { id: string; owner: string }
    404: { message: string }
    401: { message: string }
  }
}>({ service: 'order', id: 'GetOrder', method: 'GET', path: '/orders/{id}', security: true })

const loader = {
  statuses: () => [200, 404, 401],
  example: (_s: string, _o: string, status: number) =>
    status === 200 ? { id: '{{id}}', owner: 'default' } : { message: `status ${status}` },
}
const transport = createMockTransport({ loader, sleep: async () => {} })
const base = {
  env: 'mock',
  transport,
  auth: { k: { apply: { headers: { authorization: 'Bearer x' } } } },
  serviceAuth: { order: 'k' },
}

describe('mock transport', () => {
  it('serves the example and renders path vars', async () => {
    const r = await runRequest(GetOrder.request({ path: { id: 'o-7' } }), base)
    expect(r.steps[0]?.response?.body).toEqual({ id: 'o-7', owner: 'default' })
  })
  it('request-level override beats example, with init generators', async () => {
    const def = GetOrder.request({
      path: { id: 'o-1' },
      init: { who: () => 'Ada' },
      mock: {
        responses: {
          200: { data: { id: '{{id}}', owner: '{{who}}' }, init: { who: () => 'Grace' } },
        },
      },
    })
    const r = await runRequest(def, base)
    expect(r.steps[0]?.response?.body).toEqual({ id: 'o-1', owner: 'Grace' })
  })
  it('.with({ mock: { status } }) forces an error response', async () => {
    const def = GetOrder.request({ path: { id: 'x' } }).with({ mock: { status: 404 } })
    const r = await runRequest(def, base)
    expect(r.steps[0]?.response?.status).toBe(404)
  })
  it('mock.when picks status from request data', async () => {
    const def = GetOrder.request({
      path: { id: 'missing' },
      mock: { when: ({ path }) => ((path as any).id === 'missing' ? 404 : undefined) },
    })
    const r = await runRequest(def, base)
    expect(r.steps[0]?.response?.status).toBe(404)
  })
  it('secured op without credentials answers 401', async () => {
    const r = await runRequest(GetOrder.request({ path: { id: 'x' } }), { env: 'mock', transport })
    expect(r.steps[0]?.response?.status).toBe(401)
  })
})

describe('mock overrides layer over examples', () => {
  it('deep-merges partial overrides onto the generated example', async () => {
    const def = GetOrder.request({
      path: { id: 'o-9' },
      mock: { responses: { 200: { owner: 'Grace' } } },
    })
    const r = await runRequest(def, base)
    expect(r.steps[0]?.response?.body).toEqual({ id: 'o-9', owner: 'Grace' })
  })
})

describe('statuses without a response body', () => {
  it('answers with an empty body instead of failing', async () => {
    const def = GetOrder.request({ path: { id: 'x' } }).with({ mock: { status: 404 } })
    const t = createMockTransport({
      loader: {
        statuses: () => [200, 404],
        example: (_s, _o, st) => (st === 200 ? { id: 'x' } : undefined),
      },
    })
    const r = await runRequest(def, { env: 'mock', transport: t })
    expect(r.steps[0]?.response?.status).toBe(404)
    expect(r.steps[0]?.error).toBeUndefined()
  })
})
