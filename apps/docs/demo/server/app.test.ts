import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validate } from '../../../../packages/ui/src/schema'
import { createDemoApp } from './app'
import { memoryStore } from './store'

const generated = join(import.meta.dirname, '../.generated')
const json = (file: string) => JSON.parse(readFileSync(join(generated, file), 'utf8'))
const defs = json('petstore/schemas/definitions.schema.json')

/** The schema a response of this operation must match, from the spec, for a status. */
const schemaOf = (operation: string, status: number) =>
  json(`petstore/schemas/${operation}.responses.schema.json`)[String(status)]

const fresh = (
  options: Parameters<typeof createDemoApp>[0] extends infer O ? Partial<O> : never = {},
) => {
  const store = memoryStore()
  const app = createDemoApp({
    store,
    clock: () => new Date('2026-01-01T00:00:00Z'),
    sleep: async () => {},
    ...options,
  })
  return { app, store }
}
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const put = (body: unknown) => ({ ...post(body), method: 'PUT' })
const chaos = (app: ReturnType<typeof fresh>['app'], patch: object) =>
  app.request('/api/_demo/chaos', put(patch))

describe('the demo API answers as the spec says', () => {
  const conforms = (operation: string, status: number, value: unknown) =>
    expect(validate(value, schemaOf(operation, status), defs, { reportExtra: true })).toEqual([])

  it('lists pets by status, and a pet by id', async () => {
    const { app } = fresh()
    const list = await app.request('/api/petstore/pet/findByStatus?status=available')
    expect(list.status).toBe(200)
    const pets = (await list.json()) as { name: string; status: string }[]
    expect(pets.map((p) => p.name)).toEqual(['Rex', 'Mittens', 'Pip'])
    conforms('FindPetsByStatus', 200, pets)
    expect(
      await (await app.request('/api/petstore/pet/findByStatus?status=sold,pending')).json(),
    ).toHaveLength(2)

    const one = await app.request('/api/petstore/pet/1')
    expect(one.status).toBe(200)
    conforms('GetPetById', 200, await one.json())
  })

  it('adds a pet, and has it afterwards', async () => {
    const { app } = fresh()
    const added = await app.request(
      '/api/petstore/pet',
      post({ id: 1001, name: 'Biscuit', photoUrls: ['https://example.com/b.png'] }),
    )
    expect(added.status).toBe(200)
    conforms('AddPet', 200, await added.json())
    const back = (await (await app.request('/api/petstore/pet/1001')).json()) as { name: string }
    expect(back.name).toBe('Biscuit')
    // no id: the store gives the next one
    const auto = (await (
      await app.request('/api/petstore/pet', post({ name: 'Auto', photoUrls: [] }))
    ).json()) as { id: number }
    expect(auto.id).toBe(1002)
  })

  it('places an order and finds it, stamped with the clock it was given', async () => {
    const { app } = fresh()
    const placed = await app.request(
      '/api/petstore/store/order',
      post({ petId: 1, quantity: 2, status: 'placed', complete: false }),
    )
    expect(placed.status).toBe(200)
    const order = (await placed.json()) as { id: number; shipDate: string }
    expect(order.id).toBe(5002)
    expect(order.shipDate).toBe('2026-01-01T00:00:00.000Z')
    conforms('PlaceOrder', 200, order)
    const found = await app.request(`/api/petstore/store/order/${order.id}`)
    conforms('GetOrderById', 200, await found.json())
  })

  it('refuses what the spec refuses, in the spec’s shape', async () => {
    const { app } = fresh()
    expect((await app.request('/api/petstore/pet/findByStatus?status=lost')).status).toBe(400)
    expect((await app.request('/api/petstore/pet/abc')).status).toBe(400)
    expect((await app.request('/api/petstore/pet/999')).status).toBe(404)
    expect((await app.request('/api/petstore/pet', post({ name: 'No photos' }))).status).toBe(422)
    expect((await app.request('/api/petstore/store/order/1')).status).toBe(404)
    const missing = await app.request('/api/petstore/pet/999')
    expect(await missing.json()).toMatchObject({ code: 1, type: 'error', message: 'Pet not found' })
    expect((await app.request('/api/nowhere')).status).toBe(404)
  })

  it('answers the two countries questions in GraphQL', async () => {
    const { app } = fresh()
    const country = (await (
      await app.request(
        '/api/countries/',
        post({
          query: 'query ($code: ID!) { country(code: $code) { name capital } }',
          variables: { code: 'fr' },
        }),
      )
    ).json()) as { data: { country: { name: string; capital: string } } }
    expect(country.data.country).toMatchObject({ name: 'France', capital: 'Paris' })
    const continents = (await (
      await app.request('/api/countries', post({ query: '{ continents { code name } }' }))
    ).json()) as { data: { continents: unknown[] } }
    expect(continents.data.continents).toHaveLength(7)
    const other = (await (
      await app.request('/api/countries/', post({ query: '{ languages { code } }' }))
    ).json()) as {
      errors: { message: string }[]
    }
    expect(other.errors[0]?.message).toContain('continents')
  })
})

describe('what it keeps', () => {
  it('is still there after the worker was stopped and started again, and a reset forgets it', async () => {
    const store = memoryStore()
    const a = fresh({ store }).app
    await a.request('/api/petstore/pet', post({ id: 77, name: 'Kept', photoUrls: [] }))
    await chaos(a, { latencyMs: 5 })
    // a second app on the same store is the worker after the browser restarted it
    const b = fresh({ store }).app
    expect(
      ((await (await b.request('/api/petstore/pet/77')).json()) as { name: string }).name,
    ).toBe('Kept')
    expect(await (await b.request('/api/_demo/chaos')).json()).toMatchObject({ latencyMs: 5 })

    expect((await b.request('/api/_demo/reset', { method: 'POST' })).status).toBe(200)
    expect((await b.request('/api/petstore/pet/77')).status).toBe(404)
    expect(await (await b.request('/api/_demo/chaos')).json()).toMatchObject({ latencyMs: 0 })
    expect(await store.read()).toBeDefined()
  })
})

describe('chaos', () => {
  it('fails every request until it is switched off, and says why', async () => {
    const { app } = fresh()
    await chaos(app, { fail: true })
    const res = await app.request('/api/petstore/pet/1')
    expect(res.status).toBe(500)
    expect(res.headers.get('x-specbook-demo')).toBe('chaos=fail')
    // the controls themselves still answer
    expect((await app.request('/api/_demo/chaos')).status).toBe(200)
    await chaos(app, { fail: false })
    expect((await app.request('/api/petstore/pet/1')).status).toBe(200)
  })

  it('fails the next few requests and then recovers: a flaky service', async () => {
    const { app } = fresh()
    await chaos(app, { failNext: 2 })
    expect((await app.request('/api/petstore/pet/1')).status).toBe(500)
    expect((await app.request('/api/petstore/pet/1')).status).toBe(500)
    expect((await app.request('/api/petstore/pet/1')).status).toBe(200)
    expect(
      ((await (await app.request('/api/_demo/chaos')).json()) as { failNext: number }).failNext,
    ).toBe(0)
  })

  it('waits before it answers', async () => {
    const waited: number[] = []
    const { app } = fresh({ sleep: async (ms) => void waited.push(ms) })
    await chaos(app, { latencyMs: 1500 })
    expect((await app.request('/api/petstore/pet/1')).status).toBe(200)
    expect(waited).toEqual([1500])
  })

  it('changes what it says, which a check on the old data catches, or hides what exists', async () => {
    const { app } = fresh()
    await chaos(app, { mutate: true })
    const pet = (await (await app.request('/api/petstore/pet/1')).json()) as { status: string }
    const order = (await (await app.request('/api/petstore/store/order/5001')).json()) as {
      status: string
    }
    expect(pet.status).toBe('sold')
    expect(order.status).toBe('delivered')
    await chaos(app, { mutate: false, notFound: true })
    expect((await app.request('/api/petstore/pet/1')).status).toBe(404)
    expect((await app.request('/api/petstore/store/order/5001')).status).toBe(404)
  })

  it('takes only what it understands, and keeps the rest', async () => {
    const { app } = fresh()
    await chaos(app, { latencyMs: 20, nonsense: 1, failNext: 'many' })
    expect(await (await app.request('/api/_demo/chaos')).json()).toEqual({
      fail: false,
      failNext: 0,
      latencyMs: 20,
      mutate: false,
      notFound: false,
    })
    await chaos(app, { latencyMs: 99_999_999 })
    expect(
      ((await (await app.request('/api/_demo/chaos')).json()) as { latencyMs: number }).latencyMs,
    ).toBe(10_000)
  })
})

describe('the demo API verifies a Turnstile token as Cloudflare does', () => {
  const SECRET = '1x0000000000000000000000000000000AA'
  const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'
  const verify = (app: ReturnType<typeof fresh>['app'], fields: Record<string, string>) =>
    app.request('/api/turnstile/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    })
  const answer = async (res: Response) => (await res.json()) as Record<string, unknown>

  it('accepts the token the test site key gives, with the test secret', async () => {
    const { app } = fresh()
    const res = await verify(app, { secret: SECRET, response: TOKEN })
    expect(res.status).toBe(200)
    expect(await answer(res)).toEqual({
      success: true,
      'error-codes': [],
      challenge_ts: '2026-01-01T00:00:00.000Z',
      hostname: 'docs.specbook.dev',
    })
  })

  it('answers 200 with the reason when it does not, as the real endpoint does', async () => {
    const { app } = fresh()
    for (const [fields, code] of [
      [{ response: TOKEN }, 'missing-input-secret'],
      [{ secret: SECRET }, 'missing-input-response'],
      [{ secret: 'not-the-secret', response: TOKEN }, 'invalid-input-secret'],
      [{ secret: SECRET, response: 'some-other-token' }, 'invalid-input-response'],
    ] as const) {
      const res = await verify(app, fields)
      expect(res.status).toBe(200)
      expect(await answer(res)).toEqual({ success: false, 'error-codes': [code] })
    }
  })

  it('answers the shape the spec gives', async () => {
    const { app } = fresh()
    const schemas = json('turnstile/schemas/Siteverify.responses.schema.json')
    const turnstileDefs = json('turnstile/schemas/definitions.schema.json')
    const cases: Record<string, string>[] = [
      { secret: SECRET, response: TOKEN },
      { secret: SECRET },
    ]
    for (const fields of cases) {
      const body = await answer(await verify(app, fields))
      expect(validate(body, schemas['200'], turnstileDefs, { reportExtra: true })).toEqual([])
    }
  })

  it('is not told to fail by the chaos controls, which are for the APIs it stands in front of', async () => {
    const { app } = fresh()
    await chaos(app, { fail: true })
    const res = await verify(app, { secret: SECRET, response: TOKEN })
    expect(res.status).toBe(200)
    expect((await answer(res)).success).toBe(true)
  })
})
