import { describe, expect, it } from 'vitest'
import { createMockTransport, defineOperation, runRequest, withMock } from '../src/internal'
import { reflectRequest } from '../src/mock-reflect'

describe('reflectRequest', () => {
  it('copies shared body fields, keeping the response shape and the field types', () => {
    const template = {
      id: 10,
      name: 'doggie',
      category: { id: 1, name: 'Dogs' },
      photoUrls: ['https://example.com/a'],
      tags: [{ id: 1001, name: 'Example name' }],
      status: 'available',
      createdAt: '2024-05-14T09:30:00Z',
    }
    const body = {
      name: 'Rex',
      category: { name: 'Hounds' },
      photoUrls: ['u1', 'u2'],
      tags: [{ name: 'good' }, { name: 'boy' }],
      status: 'sold',
      notInResponse: 'ignored',
    }
    expect(reflectRequest(template, { body })).toEqual({
      id: 10,
      name: 'Rex',
      category: { id: 1, name: 'Hounds' },
      photoUrls: ['u1', 'u2'],
      tags: [
        { id: 1001, name: 'good' },
        { id: 1001, name: 'boy' },
      ],
      status: 'sold',
      createdAt: '2024-05-14T09:30:00Z',
    })
  })

  it('does not copy a value of a different type', () => {
    expect(
      reflectRequest({ amount: 2000, name: 'x' }, { body: { amount: 'lots', name: 5 } }),
    ).toEqual({
      amount: 2000,
      name: 'x',
    })
  })

  it('turns the only path parameter into the id, in the response field’s own type', () => {
    expect(reflectRequest({ id: 10, name: 'a' }, { path: { petId: '7' } })).toEqual({
      id: 7,
      name: 'a',
    })
    expect(reflectRequest({ id: 'a1b2', name: 'a' }, { path: { orderId: 'o-9' } })).toEqual({
      id: 'o-9',
      name: 'a',
    })
    // two path parameters are ambiguous, so only exact name matches are used
    expect(
      reflectRequest({ id: 1, owner: 'x' }, { path: { owner: 'octocat', repo: 'hello' } }),
    ).toEqual({
      id: 1,
      owner: 'octocat',
    })
  })

  it('puts a sent field where the response has it once, under another name for the object', () => {
    // request fields at the top, response wrapped: the one place each appears
    expect(
      reflectRequest(
        { budget: { budget_amount: 100, name: 'x' }, ok: true },
        { body: { budget_amount: 250, name: 'Team' } },
      ),
    ).toEqual({ budget: { budget_amount: 250, name: 'Team' }, ok: true })
    // nested in the request, flat in the response
    expect(
      reflectRequest({ id: 'ba_1', country: 'US' }, { body: { bank_account: { country: 'DE' } } }),
    ).toEqual({ id: 'ba_1', country: 'DE' })
  })

  it('does not guess when the field could be several places, or is generic', () => {
    const twice = { a: { name: 'one' }, b: { name: 'two' } }
    expect(reflectRequest(twice, { body: { name: 'sent' } })).toEqual(twice)
    // `type` somewhere deep is not the request's `type`
    const deep = { detail: { type: 'card' }, id: 1 }
    expect(reflectRequest(deep, { body: { type: 'bank' } })).toEqual(deep)
    // a value of another kind is not moved
    expect(reflectRequest({ box: { count: 3 } }, { body: { count: 'many' } })).toEqual({
      box: { count: 3 },
    })
  })

  it('answers a posted list with its first item, and a list with a list', () => {
    expect(
      reflectRequest(
        { id: 1, username: 'x', email: 'a@b.c' },
        { body: [{ username: 'ann', email: 'ann@x.io' }, { username: 'bob' }] },
      ),
    ).toEqual({ id: 1, username: 'ann', email: 'ann@x.io' })
    expect(
      reflectRequest([{ id: 1, name: 'a' }], { body: [{ name: 'Rex' }, { name: 'Tom' }] }),
    ).toEqual([
      { id: 1, name: 'Rex' },
      { id: 1, name: 'Tom' },
    ])
  })

  it('numbers that arrive as text take the response field’s number type', () => {
    expect(reflectRequest({ qty: 1, ok: true }, { body: { qty: '5' } })).toEqual({
      qty: 5,
      ok: true,
    })
  })

  it('shapes a list by the query: filters set the field, a page size sets the length', () => {
    const pets = [{ id: 10, name: 'doggie', status: 'available' }]
    expect(reflectRequest(pets, { query: { status: 'sold' } })).toEqual([
      { id: 10, name: 'doggie', status: 'sold' },
    ])
    expect(reflectRequest(pets, { query: { status: ['pending', 'sold'] } })).toEqual([
      { id: 10, name: 'doggie', status: 'pending' },
    ])
    expect(reflectRequest(pets, { query: { limit: '3' } })).toEqual([
      { id: 10, name: 'doggie', status: 'available' },
      { id: 11, name: 'doggie', status: 'available' },
      { id: 12, name: 'doggie', status: 'available' },
    ])
    // a list inside a wrapper
    expect(
      reflectRequest({ data: pets, has_more: false }, { query: { per_page: 2, status: 'sold' } }),
    ).toEqual({
      data: [
        { id: 10, name: 'doggie', status: 'sold' },
        { id: 11, name: 'doggie', status: 'sold' },
      ],
      has_more: false,
    })
    // page size is bounded
    expect(reflectRequest(pets, { query: { limit: 5000 } }) as unknown[]).toHaveLength(10)
  })

  it('applies a filter to a single object too, and leaves unknown names', () => {
    expect(
      reflectRequest({ id: 1, currency: 'usd' }, { query: { currency: 'eur', x: 1 } }),
    ).toEqual({
      id: 1,
      currency: 'eur',
    })
  })

  it('leaves lists and non-objects alone', () => {
    expect(reflectRequest([{ id: 1 }], { body: { id: 2 }, path: { id: '3' } })).toEqual([{ id: 1 }])
    expect(reflectRequest('ok', { body: { a: 1 } })).toBe('ok')
  })
})

describe('mock transport reflects the request', () => {
  const Create = defineOperation<{
    params: { path: object }
    body: { name: string; qty: number }
    responses: {
      201: { id: string; name: string; qty: number; state: string }
      400: { name: string }
    }
  }>({ service: 'shop', id: 'Create', method: 'POST', path: '/things' })
  const loader = {
    statuses: () => [201, 400],
    example: (_s: string, _o: string, status: number) =>
      status === 201 ? { id: 't_1', name: 'Example name', qty: 1, state: 'new' } : { name: 'bad' },
  }
  const transport = createMockTransport({ loader, sleep: async () => {} })

  it('answers with what was posted, and a hook can still change it', async () => {
    const r = await runRequest(Create.request({ data: { name: 'Widget', qty: 5 } }), {
      env: 'mock',
      transport,
    })
    expect(r.steps[0]?.error).toBeUndefined()
    expect(r.steps[0]?.response?.body).toEqual({ id: 't_1', name: 'Widget', qty: 5, state: 'new' })

    const pinned = await runRequest(
      withMock(Create.request({ data: { name: 'Widget', qty: 5 } }), (_req, res) => {
        if (res.status === 201) res.data.name = 'Pinned'
      }),
      { env: 'mock', transport },
    )
    expect(pinned.steps[0]?.response?.body).toMatchObject({ name: 'Pinned', qty: 5 })
  })

  it('does not reflect error responses', async () => {
    const r = await runRequest(Create.request({ data: { name: 'Widget', qty: 5 } }), {
      env: 'mock',
      transport,
      mockStatus: 400,
    })
    expect(r.steps[0]?.response?.body).toEqual({ name: 'bad' })
  })
})

describe('the mock transport applies the query', () => {
  const List = defineOperation<{
    params: { query: { status: string; limit?: number } }
    body: never
    responses: { 200: { id: number; name: string; status: string }[] }
  }>({ service: 'pets', id: 'List', method: 'GET', path: '/pets' })
  const transport = createMockTransport({
    loader: {
      statuses: () => [200],
      example: () => [{ id: 1, name: 'doggie', status: 'available' }],
    },
    sleep: async () => {},
  })

  it('filters and sizes the generated list the way the request asked', async () => {
    const r = await runRequest(List.request({ query: { status: 'sold', limit: 2 } }), {
      env: 'mock',
      transport,
    })
    expect(r.steps[0]?.error).toBeUndefined()
    expect(r.steps[0]?.response?.body).toEqual([
      { id: 1, name: 'doggie', status: 'sold' },
      { id: 2, name: 'doggie', status: 'sold' },
    ])
  })
})
