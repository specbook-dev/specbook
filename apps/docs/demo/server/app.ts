import { Hono } from 'hono'
import type { ApiResponse, Order, Pet } from '#api/petstore'
import { continents, countries, seed } from './seed'
import type { Chaos, DemoState, Store } from './store'

export interface DemoOptions {
  store: Store
  /** the time orders are stamped with; fixed in recordings */
  clock?: () => Date
  /** waits for the chaos latency; tests pass a fast one */
  sleep?: (ms: number) => Promise<void>
}

const error = (code: number, type: string, message: string): ApiResponse => ({
  code,
  type,
  message,
})

const STATUSES = ['available', 'pending', 'sold'] as const

/** What Cloudflare's published test site keys and secret make: the token the widget gives, and the secret that accepts it. */
const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA'

/**
 * The demo API: the Petstore operations the docs' requests and flows use, and a small Countries GraphQL endpoint.
 * It answers on one origin under `/api`, from a service worker in the browser and from node when a recording or a test
 * needs the same thing. All of its state is in the `store`, and chaos (a failing, slow or changing API) is switched on
 * under `/api/_demo`.
 */
export function createDemoApp({ store, clock = () => new Date(), sleep }: DemoOptions) {
  const wait = sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let state: DemoState | undefined

  /** Loaded once per worker life; every change is saved before it is answered, so a stopped worker loses nothing. */
  const load = async () => {
    state ??= (await store.read()) ?? seed()
    return state
  }
  const save = async () => store.write(state as DemoState)

  const app = new Hono().basePath('/api')

  // chaos applies to the APIs, not to the controls that switch it
  app.use('/petstore/*', chaos)
  app.use('/countries/*', chaos)
  app.use('/countries', chaos)

  async function chaos(c: import('hono').Context, next: () => Promise<void>) {
    const s = await load()
    const { chaos: k } = s
    if (k.latencyMs > 0) await wait(k.latencyMs)
    const tell = (why: string) => c.header('x-specbook-demo', `chaos=${why}`)
    if (k.fail || k.failNext > 0) {
      const why = k.fail ? 'fail' : 'fail-next'
      if (!k.fail) {
        k.failNext--
        await save()
      }
      tell(why)
      return c.json(error(500, 'error', 'The demo API was told to fail (chaos).'), 500)
    }
    await next()
    if (k.latencyMs > 0) tell('latency')
  }

  const mutate = (k: Chaos) => k.mutate
  const hidden = (k: Chaos) => k.notFound

  // ---- Cloudflare Turnstile: the one call a server makes with the token the widget gave a page. The real endpoint answers 200
  // whether the token is good or not, and so does this one. It accepts only what Cloudflare's test keys make, so the demo
  // needs no account and no secret of its own.
  app.post('/turnstile/siteverify', async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
    const secret = typeof form.secret === 'string' ? form.secret : ''
    const response = typeof form.response === 'string' ? form.response : ''
    const fail = (...codes: string[]) => c.json({ success: false, 'error-codes': codes })
    if (!secret) return fail('missing-input-secret')
    if (!response) return fail('missing-input-response')
    if (secret !== TURNSTILE_TEST_SECRET) return fail('invalid-input-secret')
    if (response !== TURNSTILE_TEST_TOKEN) return fail('invalid-input-response')
    return c.json({
      success: true,
      'error-codes': [],
      challenge_ts: clock().toISOString(),
      hostname: 'docs.specbook.dev',
    })
  })

  // ---- Petstore
  app.get('/petstore/pet/findByStatus', async (c) => {
    const s = await load()
    const asked = (c.req.query('status') ?? 'available').split(',')
    if (!asked.every((x) => (STATUSES as readonly string[]).includes(x)))
      return c.json(error(400, 'error', 'Invalid status value'), 400)
    return c.json(s.pets.filter((p) => asked.includes(p.status ?? 'available')))
  })

  app.get('/petstore/pet/:petId', async (c) => {
    const s = await load()
    const id = Number(c.req.param('petId'))
    if (!Number.isInteger(id)) return c.json(error(400, 'error', 'Invalid ID supplied'), 400)
    const pet = s.pets.find((p) => p.id === id)
    if (!pet || hidden(s.chaos)) return c.json(error(1, 'error', 'Pet not found'), 404)
    c.header('x-specbook-demo', mutate(s.chaos) ? 'chaos=mutate' : '')
    return c.json(mutate(s.chaos) ? { ...pet, status: 'sold' } : pet)
  })

  app.post('/petstore/pet', async (c) => {
    const s = await load()
    const body = (await c.req.json().catch(() => undefined)) as Partial<Pet> | undefined
    if (!body || typeof body.name !== 'string' || !Array.isArray(body.photoUrls))
      return c.json(
        error(422, 'error', 'Validation exception: a pet needs a name and photoUrls'),
        422,
      )
    const id =
      typeof body.id === 'number' ? body.id : Math.max(0, ...s.pets.map((p) => p.id ?? 0)) + 1
    const pet: Pet = { ...body, id, name: body.name, photoUrls: body.photoUrls }
    s.pets = [...s.pets.filter((p) => p.id !== id), pet]
    await save()
    return c.json(pet)
  })

  app.post('/petstore/store/order', async (c) => {
    const s = await load()
    const body = (await c.req.json().catch(() => undefined)) as Partial<Order> | undefined
    if (!body || typeof body.petId !== 'number')
      return c.json(error(422, 'error', 'Invalid input: an order needs a petId'), 422)
    const order: Order = {
      id: typeof body.id === 'number' ? body.id : s.nextOrderId++,
      petId: body.petId,
      quantity: body.quantity ?? 1,
      shipDate: body.shipDate ?? clock().toISOString(),
      status: body.status ?? 'placed',
      complete: body.complete ?? false,
    }
    s.orders = [...s.orders.filter((o) => o.id !== order.id), order]
    await save()
    return c.json(order)
  })

  app.get('/petstore/store/order/:orderId', async (c) => {
    const s = await load()
    const id = Number(c.req.param('orderId'))
    if (!Number.isInteger(id)) return c.json(error(400, 'error', 'Invalid ID supplied'), 400)
    const order = s.orders.find((o) => o.id === id)
    if (!order || hidden(s.chaos)) return c.json(error(1, 'error', 'Order not found'), 404)
    c.header('x-specbook-demo', mutate(s.chaos) ? 'chaos=mutate' : '')
    return c.json(mutate(s.chaos) ? { ...order, status: 'delivered' } : order)
  })

  // ---- Countries (GraphQL): answers the two questions the docs ask, by what the query names
  const graphql = async (c: import('hono').Context) => {
    const body = (await c.req.json().catch(() => undefined)) as
      | { query?: string; variables?: { code?: string } }
      | undefined
    const query = body?.query ?? ''
    if (/\bcontinents\b/.test(query)) return c.json({ data: { continents } })
    if (/\bcountry\s*\(/.test(query)) {
      const literal = /country\s*\(\s*code\s*:\s*"([A-Za-z]{2})"/.exec(query)?.[1]
      const code = (body?.variables?.code ?? literal ?? '').toUpperCase()
      return c.json({ data: { country: countries.find((x) => x.code === code) ?? null } })
    }
    return c.json({
      errors: [{ message: 'The demo answers `country(code:)` and `continents` only.' }],
    })
  }
  app.post('/countries', graphql)
  app.post('/countries/', graphql)

  // ---- the controls
  app.get('/_demo/chaos', async (c) => c.json((await load()).chaos))
  app.put('/_demo/chaos', async (c) => {
    const s = await load()
    const patch = (await c.req.json().catch(() => ({}))) as Partial<Chaos>
    const flag = (v: unknown, was: boolean) => (typeof v === 'boolean' ? v : was)
    const count = (v: unknown, was: number, max: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : was
    const next: Chaos = {
      fail: flag(patch.fail, s.chaos.fail),
      failNext: count(patch.failNext, s.chaos.failNext, 20),
      latencyMs: count(patch.latencyMs, s.chaos.latencyMs, 10_000),
      mutate: flag(patch.mutate, s.chaos.mutate),
      notFound: flag(patch.notFound, s.chaos.notFound),
    }
    s.chaos = next
    await save()
    return c.json(next)
  })
  app.post('/_demo/reset', async (c) => {
    state = seed()
    await store.clear()
    await save()
    return c.json({ reset: true })
  })

  app.notFound((c) =>
    c.json(error(404, 'error', 'Nothing here: this is the Specbook demo API.'), 404),
  )
  return app
}

export type DemoApp = ReturnType<typeof createDemoApp>
