import { describe, expect, it } from 'vitest'
import {
  type AuthProfile,
  c,
  collectSecretNames,
  defineOperation,
  exitCode,
  formatPretty,
  MissingSecretsError,
  request,
  runRequest,
  runSequence,
  sequence,
  toJUnit,
} from '../src'
import { fakeTransport } from './helpers'

const CreateOrder = defineOperation<{
  params: {}
  body: { itemCode: string; quantity: number | string }
  responses: { 201: { id: string; status: string; quantity: number }; 400: { message: string } }
}>({ service: 'order', id: 'CreateOrder', method: 'POST', path: '/orders' })

const GetOrder = defineOperation<{
  params: { path: { id: string } }
  body: never
  responses: { 200: { id: string; itemCode: string }; 404: { message: string } }
}>({ service: 'order', id: 'GetOrder', method: 'GET', path: '/orders/{id}' })

const create = CreateOrder.request({
  init: { qty: 3, code: () => 'BOOK-1' },
  data: { itemCode: '{{code}}', quantity: '{{qty}}' },
  capture: { orderId: (res) => (res.status === 201 ? res.data.id : '') },
  assert: (res, { assert }) => {
    assert.is(res.status, 201, 'created')
    assert.is(res.status === 201 && res.data.quantity, 3, 'quantity echoed')
  },
})

function fakeOrderApi() {
  return fakeTransport((req) => {
    if (req.method === 'POST')
      return {
        status: 201,
        body: { id: 'ord_1', status: 'PENDING', quantity: (req.body as any).quantity },
      }
    return { status: 200, body: { id: req.url.split('/').pop(), itemCode: 'BOOK-1' } }
  })
}

describe('runRequest', () => {
  it('renders templates, captures and records passing assertions', async () => {
    const { transport, calls } = fakeOrderApi()
    const r = await runRequest(create, { env: 'mock', transport })
    expect(calls[0]?.body).toEqual({ itemCode: 'BOOK-1', quantity: 3 })
    expect(r.status).toBe('pass')
    expect(r.steps[0]?.captured).toEqual({ orderId: 'ord_1' })
    expect(r.steps[0]?.assertions.map((a) => [a.label, a.pass])).toEqual([
      ['created', true],
      ['quantity echoed', true],
    ])
    expect(r.totals.assertions).toEqual({ passed: 2, failed: 0 })
  })

  it('.with() overrides vars and deep-merges data without mutating the original', async () => {
    const { transport, calls } = fakeOrderApi()
    const big = create.with({ vars: { qty: 10 }, data: { itemCode: 'OTHER' } })
    await runRequest(big, { env: 'mock', transport })
    expect(calls[0]?.body).toEqual({ itemCode: 'OTHER', quantity: 10 })
    await runRequest(create, { env: 'mock', transport })
    expect(calls[1]?.body).toEqual({ itemCode: 'BOOK-1', quantity: 3 })
  })

  it('runtime overrides beat init and with()', async () => {
    const { transport, calls } = fakeOrderApi()
    await runRequest(create.with({ vars: { qty: 10 } }), {
      env: 'mock',
      transport,
      overrides: { qty: 7 },
    })
    const sent = calls[0]?.body as { quantity: number } | undefined
    expect(sent?.quantity).toBe(7)
  })

  it('soft assertions: all checks report, step fails', async () => {
    const { transport } = fakeTransport(() => ({ status: 400, body: { message: 'bad' } }))
    const r = await runRequest(create, { env: 'mock', transport })
    expect(r.status).toBe('fail')
    const a = r.steps[0]?.assertions ?? []
    expect(a).toHaveLength(2)
    expect(a.every((x) => !x.pass)).toBe(true)
    expect(exitCode([r])).toBe(1)
  })

  it('hard assertMode stops at the first failure', async () => {
    const { transport } = fakeTransport(() => ({ status: 400, body: { message: 'bad' } }))
    const r = await runRequest(create.with({ assertMode: 'hard' }), { env: 'mock', transport })
    expect(r.steps[0]?.assertions).toHaveLength(1)
    expect(r.status).toBe('fail')
  })

  it('fills path params and encodes them', async () => {
    const { transport, calls } = fakeOrderApi()
    await runRequest(GetOrder.request({ path: { id: 'a b' } }), { env: 'mock', transport })
    expect(calls[0]?.url).toBe('/orders/a%20b')
  })

  it('errors clearly on missing variables', async () => {
    const { transport } = fakeOrderApi()
    const r = await runRequest(
      CreateOrder.request({ data: { itemCode: '{{missing}}', quantity: 1 } }),
      { env: 'mock', transport },
    )
    expect(r.status).toBe('error')
    expect(r.steps[0]?.error).toContain('{{missing}}')
    expect(exitCode([r])).toBe(2)
  })

  it('works for untyped request()', async () => {
    const { transport, calls } = fakeTransport(() => ({ body: { ok: true } }))
    await runRequest(request({ method: 'GET', url: '/ping', query: { a: '1' } as any }), {
      env: 'mock',
      transport,
    })
    expect(calls[0]?.url).toBe('/ping')
    expect(calls[0]?.query).toEqual({ a: '1' })
  })
})

describe('secrets & masking', () => {
  const withKey = CreateOrder.request({
    headers: { 'x-api-key': '{{secrets.ORDER_KEY}}' },
    data: { itemCode: 'A', quantity: 1 },
    assert: (res, { assert }) => assert.is(res.status, 201),
  })

  it('substitutes secrets only at the wire and keeps placeholders in results', async () => {
    const { transport, calls } = fakeOrderApi()
    const r = await runRequest(withKey, {
      env: 'live',
      transport,
      secrets: { ORDER_KEY: 'sk_live_abcdef' },
    })
    expect(calls[0]?.headers['x-api-key']).toBe('sk_live_abcdef')
    expect(r.steps[0]?.request?.headers['x-api-key']).toBe('{{secrets.ORDER_KEY}}')
  })

  it('masks secret values echoed in responses', async () => {
    const { transport } = fakeTransport((req) => ({
      status: 201,
      body: { id: 'x', status: 'echo', quantity: 1, leak: req.headers['x-api-key'] },
    }))
    const r = await runRequest(withKey, {
      env: 'live',
      transport,
      secrets: { ORDER_KEY: 'sk_live_abcdef' },
    })
    expect(JSON.stringify(r)).not.toContain('sk_live_abcdef')
    expect(JSON.stringify(r)).toContain('***')
  })

  it('missing secret is an error before anything is sent', async () => {
    const { transport, calls } = fakeOrderApi()
    const r = await runRequest(withKey, { env: 'live', transport, secrets: {} })
    expect(r.status).toBe('error')
    expect(calls).toHaveLength(0)
    expect(await collectSecretNames(withKey)).toEqual(new Set(['ORDER_KEY']))
    expect(new MissingSecretsError(['A']).names).toEqual(['A'])
  })
})

describe('runSequence', () => {
  const seq = sequence({
    id: 'checkout',
    title: 'Checkout',
    inputs: { n: c.number({ default: 2 }) },
  })
    .step('Create', create)
    .each(
      'Fetch',
      (ctx) => Array.from({ length: ctx.inputs.n }, (_, i) => `o${i}`),
      (id) =>
        GetOrder.request({
          path: { id },
          capture: { fetchedId: (res) => (res.status === 200 ? res.data.id : '') },
        }),
    )
    .step('Verify', (ctx) =>
      GetOrder.request({
        path: { id: ctx.captured.orderId },
        assert: (res, { assert }) => assert.is(res.status, 200),
      }),
    )
    .check('collected', (ctx, { assert }) => {
      assert.equal(ctx.captured.fetchedId, ['o0', 'o1'])
    })

  it('runs steps, each() and checks with captures flowing forward', async () => {
    const { transport, calls } = fakeOrderApi()
    const r = await runSequence(seq, { env: 'mock', transport })
    expect(r.status).toBe('pass')
    expect(calls.map((c) => c.url)).toEqual([
      '/orders',
      '/orders/o0',
      '/orders/o1',
      '/orders/ord_1',
    ])
    expect(r.totals.steps).toBe(5)
    expect(formatPretty([r])).toContain('✓ Checkout')
    expect(toJUnit([r])).toContain('<testsuite name="Checkout"')
  })

  it('bails after a failed step and marks the rest skipped', async () => {
    const { transport } = fakeTransport(() => ({ status: 500, body: {} }))
    const r = await runSequence(seq, { env: 'mock', transport })
    expect(r.steps.map((s) => s.status)).toEqual(['fail', 'skipped', 'skipped', 'skipped'])
    expect(r.totals.skipped).toBe(3)
  })

  it('continueOnFailure keeps going', async () => {
    const s = sequence({ id: 'x', title: 'X', continueOnFailure: true })
      .step('a', create)
      .step('b', create)
    const { transport } = fakeTransport(() => ({ status: 500, body: {} }))
    const r = await runSequence(s, { env: 'mock', transport })
    expect(r.steps.map((x) => x.status)).toEqual(['fail', 'fail'])
  })

  it('input() offers options built from captured data and merges the choice into inputs', async () => {
    const Search = defineOperation<{
      params: {}
      body: never
      responses: { 200: { id: string; code: string }[] }
    }>({ service: 'f', id: 'Search', method: 'GET', path: '/flights' })
    const s = sequence({ id: 'f', title: 'Flights' })
      .step('Search', Search.request({ capture: { flights: (r) => r.data } }))
      .input('Choose', (ctx) => ({
        flightId: c.select(ctx.captured.flights, {
          label: (f) => f.code,
          value: (f) => f.id,
          default: 0,
        }),
      }))
      .step('Book', (ctx) => request({ method: 'POST', url: `/book/${ctx.inputs.flightId}` }))
    const { transport, calls } = fakeTransport((req) =>
      req.url === '/flights'
        ? {
            body: [
              { id: 'a', code: 'X1' },
              { id: 'b', code: 'X2' },
            ],
          }
        : { body: {} },
    )
    let offered: unknown
    const r = await runSequence(s, {
      env: 'mock',
      transport,
      onInput: ({ controls }) => {
        offered = controls
        return { flightId: 'b' }
      },
    })
    expect(offered).toEqual({
      flightId: {
        kind: 'select',
        options: [
          { label: 'X1', value: 'a' },
          { label: 'X2', value: 'b' },
        ],
      },
    })
    expect(calls.at(-1)?.url).toBe('/book/b')
    expect(r.status).toBe('pass')

    // headless: default index 0
    const h = await runSequence(s, { env: 'mock', transport })
    expect(calls.at(-1)?.url).toBe('/book/a')
    expect(h.status).toBe('pass')
  })
})

describe('auth profiles', () => {
  const Login = defineOperation<{
    params: {}
    body: { username: string }
    responses: { 200: { access_token: string; expires_in: number } }
  }>({ service: 'auth', id: 'Login', method: 'POST', path: '/login', security: false })

  const profile = (): AuthProfile => ({
    login: async () => Login.request({ data: { username: 'qa' } }),
    token: (res) => ({ accessToken: res.data.access_token, expiresIn: res.data.expires_in }),
    apply: { headers: { authorization: 'Bearer {{session.accessToken}}' } },
  })
  const authOpts = { auth: { user: profile() }, serviceAuth: { order: 'user' } }

  it('logs in once for parallel use, applies the token and shows a visible auth step', async () => {
    let n = 0
    const { transport, calls } = fakeTransport((req) =>
      req.url === '/login'
        ? { body: { access_token: `tok_${++n}_secretvalue`, expires_in: 3600 } }
        : { status: 201, body: { id: 'o', status: 'P', quantity: 3 } },
    )
    const s = sequence({ id: 's', title: 'S' }).step('a', create).step('b', create)
    const r = await runSequence(s, { env: 'mock', transport, ...authOpts })
    expect(calls.filter((c) => c.url === '/login')).toHaveLength(1)
    expect(
      calls
        .filter((c) => c.url === '/orders')
        .every((c) => c.headers.authorization === 'Bearer tok_1_secretvalue'),
    ).toBe(true)
    expect(r.steps.map((x) => x.kind)).toEqual(['auth', 'request', 'request'])
    expect(JSON.stringify(r)).not.toContain('tok_1_secretvalue')
  })

  it('re-logs in on 401 and replays once', async () => {
    let logins = 0
    const { transport, calls } = fakeTransport((req) => {
      if (req.url === '/login')
        return { body: { access_token: `tok${++logins}_aaaaaa`, expires_in: 60 } }
      return req.headers.authorization === 'Bearer tok2_aaaaaa'
        ? { status: 201, body: { id: 'o', status: 'P', quantity: 3 } }
        : { status: 401, body: {} }
    })
    const r = await runRequest(create, { env: 'mock', transport, ...authOpts })
    expect(logins).toBe(2)
    expect(calls.filter((c) => c.url === '/orders')).toHaveLength(2)
    expect(r.status).toBe('pass')
  })

  it('expired sessions log in again; auth:false sends no header', async () => {
    let t = 0
    let logins = 0
    const { transport, calls } = fakeTransport((req) =>
      req.url === '/login'
        ? { body: { access_token: `tok${++logins}_aaaaaa`, expires_in: 10 } }
        : { status: 201, body: { id: 'o', status: 'P', quantity: 3 } },
    )
    const s = sequence({ id: 's', title: 'S' })
      .step('a', create)
      .step('b', create)
      .step('c', create.with({ auth: false }))
    const r = await runSequence(s, {
      env: 'mock',
      transport,
      ...authOpts,
      now: () => {
        t += 20_000 // each read advances 20s so the 10s session is always expired
        return t
      },
    })
    expect(logins).toBe(2)
    expect(calls.at(-1)?.headers.authorization).toBeUndefined()
    expect(r.status).toBe('pass')
  })
})

describe('mock env secrets', () => {
  it('does not require secrets in the mock env', async () => {
    const { transport, calls } = fakeTransport(() => ({
      status: 201,
      body: { id: 'x', status: 'p', quantity: 1 },
    }))
    const def = CreateOrder.request({
      headers: { 'x-api-key': '{{secrets.NOPE}}' },
      data: { itemCode: 'A', quantity: 1 },
    })
    const r = await runRequest(def, { env: 'mock', transport })
    expect(r.status).toBe('pass')
    expect(calls[0]?.headers['x-api-key']).toBe('{{secrets.NOPE}}')
  })
})

describe('masking every form of a secret, in events as well as results', () => {
  const echo = CreateOrder.request({
    headers: { 'x-api-key': '{{secrets.ORDER_KEY}}' },
    data: { itemCode: 'A', quantity: 1 },
    capture: { echoed: (res) => (res.data as any).leak },
    assert: (res, { assert }) => assert.is((res.data as any).leak, 'nope', 'echo'),
  })
  const secret = 'sk live/abc+123'

  it('masks the secret in streamed events, including captures and failed assertions', async () => {
    const { transport } = fakeTransport((req) => ({
      status: 201,
      body: { leak: req.headers['x-api-key'] },
    }))
    const events: unknown[] = []
    await runRequest(echo, {
      env: 'live',
      transport,
      secrets: { ORDER_KEY: secret },
      onEvent: (e) => events.push(e),
    })
    const seen = JSON.stringify(events)
    expect(seen).not.toContain(secret)
    expect(seen).toContain('***')
    // the capture and the failing assertion were among the events
    expect(events.some((e: any) => e.type === 'capture')).toBe(true)
    expect(events.some((e: any) => e.type === 'assert:fail')).toBe(true)
  })

  it('masks the URL-encoded, JSON-escaped and base64 forms', async () => {
    const forms = [
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
      btoa(secret),
      `https://x.test/?k=${encodeURIComponent(secret)}`,
    ]
    const { transport } = fakeTransport(() => ({ status: 201, body: { leak: forms } }))
    const r = await runRequest(echo, { env: 'live', transport, secrets: { ORDER_KEY: secret } })
    const out = JSON.stringify(r)
    for (const f of forms) expect(out).not.toContain(f)
  })

  it('masks a short secret of three characters but leaves two alone', async () => {
    const { transport } = fakeTransport(() => ({ status: 201, body: { leak: 'abc and xy' } }))
    const r = await runRequest(echo, { env: 'live', transport, secrets: { ORDER_KEY: 'abc' } })
    expect(JSON.stringify(r)).not.toContain('abc')
    const r2 = await runRequest(echo, { env: 'live', transport, secrets: { ORDER_KEY: 'xy' } })
    expect(JSON.stringify(r2)).toContain('xy')
  })
})

describe('a read-only run', () => {
  const Search = defineOperation<{
    params: {}
    body: { q: string }
    responses: { 200: unknown }
  }>({ service: 'order', id: 'Search', method: 'POST', path: '/search' })
  const Gql = defineOperation<{
    params: {}
    body: { query: string }
    responses: { 200: unknown }
  }>({ service: 'order', id: 'Gql', method: 'POST', path: '/graphql', encoding: 'graphql' })

  const run = (def: Parameters<typeof runRequest>[0]) => {
    const { transport, calls } = fakeTransport(() => ({ status: 200, body: {} }))
    return runRequest(def, { env: 'prod', transport, readOnly: true }).then((r) => ({ r, calls }))
  }

  it('sends reads', async () => {
    const { r, calls } = await run(GetOrder.request({ path: { id: '1' } }))
    expect(calls).toHaveLength(1)
    expect(r.steps[0]?.status).toBe('pass')
  })

  it('refuses a POST before sending it, and says how to allow it', async () => {
    const { r, calls } = await run(CreateOrder.request({ data: { itemCode: 'A', quantity: 1 } }))
    expect(calls).toHaveLength(0)
    expect(r.status).toBe('error')
    expect(r.steps[0]?.error).toBe(
      'Refusing POST /orders in "prod": this is a --safe run, which only reads.',
    )
    // the refused request is still recorded, so the report shows what would have been sent
    expect(r.steps[0]?.request?.method).toBe('POST')
  })

  it('allows a POST marked safe, and a GraphQL query, but not a mutation', async () => {
    expect((await run(Search.request({ safe: true, data: { q: 'x' } }))).calls).toHaveLength(1)
    expect((await run(Gql.request({ data: { query: '{ pets { id } }' } }))).calls).toHaveLength(1)
    const m = await run(Gql.request({ data: { query: 'mutation Add { addPet { id } }' } }))
    expect(m.calls).toHaveLength(0)
    expect(m.r.status).toBe('error')
  })

  it('still lets an auth profile log in, and is off unless asked for', async () => {
    const Login = defineOperation<{
      params: {}
      body: { username: string }
      responses: { 200: { access_token: string } }
    }>({ service: 'auth', id: 'Login', method: 'POST', path: '/login', security: false })
    const profile: AuthProfile = {
      login: async () => Login.request({ data: { username: 'qa' } }),
      token: (res) => ({ accessToken: res.data.access_token }),
      apply: { headers: { authorization: 'Bearer {{session.accessToken}}' } },
    }
    const { transport, calls } = fakeTransport((req) =>
      req.url === '/login' ? { body: { access_token: 'tok_aaaa' } } : { status: 200, body: {} },
    )
    const r = await runRequest(GetOrder.request({ path: { id: '1' } }), {
      env: 'prod',
      transport,
      readOnly: true,
      auth: { user: profile },
      serviceAuth: { order: 'user' },
    })
    expect(calls.map((c) => c.url)).toEqual(['/login', '/orders/1'])
    expect(r.status).toBe('pass')
    // without the flag a write goes through
    const open = fakeTransport(() => ({ status: 201, body: {} }))
    await runRequest(CreateOrder.request({ data: { itemCode: 'A', quantity: 1 } }), {
      env: 'prod',
      transport: open.transport,
    })
    expect(open.calls).toHaveLength(1)
  })
})

describe('tags on requests', () => {
  it('are carried by the request, merged by .with(), and reported on its result', async () => {
    const base = GetOrder.request({ tags: ['smoke'], path: { id: '1' } })
    const more = base.with({ tags: ['monitor', 'smoke'] })
    expect(more.input.tags).toEqual(['smoke', 'monitor'])
    const { transport } = fakeTransport(() => ({ status: 200, body: {} }))
    const r = await runRequest(more, { env: 'mock', transport })
    expect(r.tags).toEqual(['smoke', 'monitor'])
    // a request with no tags reports none
    expect(
      (await runRequest(GetOrder.request({ path: { id: '1' } }), { env: 'mock', transport })).tags,
    ).toEqual([])
  })
})

describe('the implicit status check', () => {
  const smoke = GetOrder.request({ path: { id: '1' } })
  const run = (def: Parameters<typeof runRequest>[0], status: number, implicit = true) => {
    const { transport } = fakeTransport(() => ({ status, body: {} }))
    return runRequest(def, { env: 'live', transport, implicitStatusCheck: implicit })
  }

  it('passes a 2xx and records it as an assertion', async () => {
    const r = await run(smoke, 200)
    expect(r.status).toBe('pass')
    expect(r.steps[0]?.assertions).toEqual([
      { label: 'status is 2xx', operator: 'status', pass: true, actual: 200, expected: '2xx' },
    ])
    expect(r.totals.assertions).toEqual({ passed: 1, failed: 0 })
  })

  it('fails a 404 and a 500 that carry no assert of their own', async () => {
    for (const status of [404, 500, 301]) {
      const r = await run(smoke, status)
      expect(r.status).toBe('fail')
      expect(r.steps[0]?.assertions[0]).toMatchObject({
        pass: false,
        actual: status,
        expected: '2xx',
      })
    }
  })

  it('leaves a request with its own assert to that assert, so a 404 can be expected', async () => {
    const expects404 = GetOrder.request({
      path: { id: '1' },
      assert: (res, { assert }) => assert.is(res.status, 404, 'not found'),
    })
    const r = await run(expects404, 404)
    expect(r.status).toBe('pass')
    expect(r.steps[0]?.assertions.map((a) => a.label)).toEqual(['not found'])
  })

  it('is off unless asked for, and does not judge an auth login', async () => {
    expect((await run(smoke, 500, false)).status).toBe('pass')
    const Login = defineOperation<{
      params: {}
      body: { username: string }
      responses: { 200: { access_token: string } }
    }>({ service: 'auth', id: 'Login', method: 'POST', path: '/login', security: false })
    const { transport } = fakeTransport((req) =>
      req.url === '/login' ? { body: { access_token: 'tok_aaaa' } } : { status: 200, body: {} },
    )
    const r = await runRequest(smoke, {
      env: 'live',
      transport,
      implicitStatusCheck: true,
      auth: {
        user: {
          login: async () => Login.request({ data: { username: 'qa' } }),
          token: (res) => ({ accessToken: res.data.access_token }),
          apply: { headers: { authorization: 'Bearer {{session.accessToken}}' } },
        },
      },
      serviceAuth: { order: 'user' },
    })
    expect(r.steps.map((s) => [s.kind, s.assertions.length])).toEqual([
      ['auth', 0],
      ['request', 1],
    ])
  })

  it('judges each request step of a flow that has no assert', async () => {
    const s = sequence({ id: 's', title: 'S' }).step('read', smoke)
    const { transport } = fakeTransport(() => ({ status: 503, body: {} }))
    const r = await runSequence(s, { env: 'live', transport, implicitStatusCheck: true })
    expect(r.status).toBe('fail')
  })
})
