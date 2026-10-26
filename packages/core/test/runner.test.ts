import { describe, expect, it } from 'vitest'
import {
  type AuthProfile,
  c,
  collectSecretNames,
  createListReporter,
  defineOperation,
  exitCode,
  flowSkipReason,
  formatList,
  formatPretty,
  MissingSecretsError,
  redactResults,
  request,
  runRequest,
  runSequence,
  type ScriptBody,
  type ScriptHost,
  script,
  scriptFlow,
  scriptSkipReason,
  sequence,
  testExitCode,
  toJUnit,
  traceLines,
  withMock,
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

  it('keeps what the error that ended a step says a page can offer, apart from its message', async () => {
    const hinted = Object.assign(new Error('blocked'), {
      hint: { code: 'not-allowed', origin: 'https://api.example.com', extra: 'dropped' },
    })
    const transport = async () => {
      throw hinted
    }
    const r = await runRequest(create, { env: 'mock', transport })
    expect(r.steps[0]?.error).toBe('blocked')
    expect(r.steps[0]?.errorHint).toEqual({
      code: 'not-allowed',
      origin: 'https://api.example.com',
    })

    // an ordinary failure carries no hint
    const plain = await runRequest(create, {
      env: 'mock',
      transport: async () => {
        throw new Error('no route to host')
      },
    })
    expect(plain.steps[0]?.errorHint).toBeUndefined()
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

  it('reaches into a captured list with brackets, and counts the list as the variable used', async () => {
    const pick = sequence({ id: 'pick', title: 'Pick' })
      .step(
        'List',
        CreateOrder.request({
          data: { itemCode: 'x', quantity: 1 },
          capture: { items: () => [{ sku: 'BOOK-9' }, { sku: 'PEN-2' }] },
        }),
      )
      .step(
        'Order',
        CreateOrder.request({
          data: { itemCode: '{{items[1].sku}}', quantity: '{{items.length}}' },
        }),
      )
    const { transport, calls } = fakeOrderApi()
    const r = await runSequence(pick, { env: 'mock', transport })
    expect(r.status).toBe('pass')
    expect(calls[1]?.body).toEqual({ itemCode: 'PEN-2', quantity: 2 })
    // `items[1].sku` and `items.length` both come from the captured `items`, listed once
    expect(r.steps[1]?.uses?.map((u) => [u.key, u.source])).toEqual([['items', 'capture']])
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
        default: 'a',
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

describe('profile resolution', () => {
  const opWith = (security: any) =>
    defineOperation<{ params: {}; body: unknown; responses: { 200: {} } }>({
      service: 'shop',
      id: 'Op',
      method: 'GET',
      path: '/x',
      security,
    })
  const auth: Record<string, AuthProfile> = {
    key: { scheme: 'api_key', apply: { headers: { 'x-key': '{{secrets.KEY}}' } } },
    oauth: {
      scheme: 'shop_auth',
      apply: { headers: { authorization: 'Bearer {{secrets.TOKEN}}' } },
    },
  }
  const run = async (security: unknown, input: Record<string, unknown> = {}) => {
    const { transport, calls } = fakeTransport(() => ({ body: {} }))
    const events: any[] = []
    await runRequest(opWith(security).request(input as any), {
      env: 'live',
      transport,
      auth,
      serviceAuth: { shop: ['key', 'oauth'] },
      secrets: { KEY: 'k', TOKEN: 't' },
      onEvent: (e) => events.push(e),
    })
    return { calls, events }
  }

  it('uses the first listed profile the operation accepts', async () => {
    const { calls, events } = await run([{ shop_auth: ['read'] }])
    expect(calls[0]?.headers.authorization).toBe('Bearer t')
    expect(calls[0]?.headers['x-key']).toBeUndefined()
    expect(events.find((e) => e.type === 'auth:profile')).toMatchObject({
      profile: 'oauth',
      reason: 'accepted',
    })
  })

  it('keeps the default when it is accepted', async () => {
    const { calls, events } = await run([{ api_key: [] }, { shop_auth: [] }])
    expect(calls[0]?.headers['x-key']).toBe('k')
    expect(events.find((e) => e.type === 'auth:profile')?.reason).toBe('default')
  })

  it('falls back to the default when nothing is accepted, and to none when the spec needs none', async () => {
    expect((await run([{ somethingElse: [] }])).calls[0]?.headers['x-key']).toBe('k')
    expect((await run(false)).calls[0]?.headers['x-key']).toBeUndefined()
    expect((await run([])).calls[0]?.headers['x-key']).toBeUndefined()
  })

  it('treats an operation with no scheme data as accepting every listed profile', async () => {
    expect((await run(true)).calls[0]?.headers['x-key']).toBe('k')
  })

  it('lets a request name its profile, or none', async () => {
    const named = await run([{ api_key: [] }], { auth: 'oauth' })
    expect(named.calls[0]?.headers.authorization).toBe('Bearer t')
    expect(named.events.find((e) => e.type === 'auth:profile')?.reason).toBe('explicit')
    expect(
      (await run([{ api_key: [] }], { auth: false })).calls[0]?.headers['x-key'],
    ).toBeUndefined()
  })

  it('scans only the secrets of the profile an operation resolves to', async () => {
    const names = await collectSecretNames(
      opWith([{ shop_auth: [] }]).request({} as any),
      auth,
      undefined,
      { shop: ['key', 'oauth'] },
    )
    expect([...names]).toEqual(['TOKEN'])
  })
})

describe('OAuth client credentials', () => {
  const Get = defineOperation<{ params: {}; body: unknown; responses: { 200: {} } }>({
    service: 'shop',
    id: 'Get',
    method: 'GET',
    path: '/things',
  })
  const profile = (extra: Record<string, unknown> = {}): AuthProfile => ({
    apply: { headers: { authorization: 'Bearer {{session.accessToken}}' } },
    oauth: {
      tokenUrl: '{{idp}}/realms/r/token?tenant=1',
      clientId: '{{secrets.CLIENT_ID}}',
      clientSecret: '{{secrets.CLIENT_SECRET}}',
      ...extra,
    },
  })
  const base = (over: Record<string, unknown> = {}) => ({
    env: 'live',
    vars: { idp: 'https://idp.test' },
    secrets: { CLIENT_ID: 'my-client', CLIENT_SECRET: 'sssshhh-secret' },
    auth: { cc: profile() },
    serviceAuth: { shop: 'cc' },
    ...over,
  })
  const server = (opts: { expiresIn?: number } = {}) => {
    let tokens = 0
    const { transport, calls } = fakeTransport((req) => {
      if (req.service === 'auth:cc')
        return {
          body: { access_token: `tok_${++tokens}_value`, expires_in: opts.expiresIn ?? 3600 },
        }
      return req.headers.authorization === `Bearer tok_${tokens}_value`
        ? { body: {} }
        : { status: 401, body: {} }
    })
    return { transport, calls, tokens: () => tokens }
  }

  it('fetches one token for several requests and applies it as a bearer', async () => {
    const { transport, calls } = server()
    const s = sequence({ id: 's', title: 'S' }).step('a', Get.request()).step('b', Get.request())
    const r = await runSequence(s, { ...base(), transport })
    const tokenCalls = calls.filter((c) => c.service === 'auth:cc')
    expect(tokenCalls).toHaveLength(1)
    expect(tokenCalls[0]).toMatchObject({
      method: 'POST',
      url: '/realms/r/token',
      query: { tenant: '1' },
      encoding: 'form',
      body: {
        grant_type: 'client_credentials',
        client_id: 'my-client',
        client_secret: 'sssshhh-secret',
      },
    })
    expect(
      calls
        .filter((c) => c.url === '/things')
        .every((c) => c.headers.authorization === 'Bearer tok_1_value'),
    ).toBe(true)
    expect(r.status).toBe('pass')
    expect(r.steps.map((x) => x.kind)).toEqual(['auth', 'request', 'request'])
    expect(r.steps[0]?.name).toBe('Token (cc)')
  })

  it('never lets the secret, the basic header or the token into a result', async () => {
    const { transport } = server()
    const events: unknown[] = []
    const r = await runRequest(Get.request(), {
      ...base({ auth: { cc: profile({ clientAuth: 'basic' }) } }),
      transport,
      onEvent: (e) => events.push(e),
    })
    const all = JSON.stringify([r, events])
    for (const secret of ['sssshhh-secret', 'tok_1_value', btoa('my-client:sssshhh-secret')])
      expect(all).not.toContain(secret)
  })

  it('sends the credentials as a basic header when asked and held, and in the body otherwise', async () => {
    const held = server()
    await runRequest(Get.request(), {
      ...base({ auth: { cc: profile({ clientAuth: 'basic' }) } }),
      transport: held.transport,
    })
    const tokenReq = held.calls.find((c) => c.service === 'auth:cc')
    expect(tokenReq?.headers.authorization).toBe(`Basic ${btoa('my-client:sssshhh-secret')}`)
    expect(tokenReq?.body).toEqual({ grant_type: 'client_credentials' })

    // a server fills the secrets later (the dev proxy): the placeholders go out as they are, in the body
    const deferred = server()
    await runRequest(Get.request(), {
      ...base({
        auth: { cc: profile({ clientAuth: 'basic' }) },
        secrets: undefined,
        deferSecrets: true,
      }),
      transport: deferred.transport,
    })
    expect(deferred.calls.find((c) => c.service === 'auth:cc')?.body).toEqual({
      grant_type: 'client_credentials',
      client_id: '{{secrets.CLIENT_ID}}',
      client_secret: '{{secrets.CLIENT_SECRET}}',
    })
  })

  const tokenBody = (calls: { service: string; body?: unknown }[]) =>
    (calls.find((c) => c.service === 'auth:cc') as { body: { scope?: string } }).body

  it('asks for the scopes the profile names, and none otherwise', async () => {
    const some = server()
    await runRequest(Get.request(), {
      ...base({ auth: { cc: profile({ scopes: { read: 'Read', write: 'Write' } }) } }),
      transport: some.transport,
    })
    expect(tokenBody(some.calls).scope).toBe('read write')
    const none = server()
    await runRequest(Get.request(), { ...base(), transport: none.transport })
    expect(tokenBody(none.calls).scope).toBeUndefined()
  })

  it('fetches a new token when the old one has expired', async () => {
    let clock = 1_000_000
    let tokens = 0
    const { transport, calls } = fakeTransport((req) => {
      if (req.service === 'auth:cc')
        return { body: { access_token: `tok_${++tokens}_value`, expires_in: 60 } }
      clock += 61_000
      return { body: {} }
    })
    const s = sequence({ id: 's', title: 'S' }).step('a', Get.request()).step('b', Get.request())
    await runSequence(s, { ...base(), transport, now: () => clock })
    expect(calls.filter((c) => c.service === 'auth:cc')).toHaveLength(2)
    expect(calls.filter((c) => c.url === '/things').map((c) => c.headers.authorization)).toEqual([
      'Bearer tok_1_value',
      'Bearer tok_2_value',
    ])
  })

  it('fetches once more after a 401 and replays the request, unless retryOn401 is off', async () => {
    const stale = fakeTransport((req) =>
      req.service === 'auth:cc'
        ? { body: { access_token: `t${Math.random()}_xxxx`, expires_in: 3600 } }
        : { status: 401, body: {} },
    )
    await runRequest(Get.request(), { ...base(), transport: stale.transport })
    expect(stale.calls.filter((c) => c.service === 'auth:cc')).toHaveLength(2)
    expect(stale.calls.filter((c) => c.url === '/things')).toHaveLength(2)

    const off = fakeTransport((req) =>
      req.service === 'auth:cc'
        ? { body: { access_token: 'tok_xxxx', expires_in: 3600 } }
        : { status: 401, body: {} },
    )
    await runRequest(Get.request(), {
      ...base({ auth: { cc: { ...profile(), retryOn401: false } } }),
      transport: off.transport,
    })
    expect(off.calls.filter((c) => c.service === 'auth:cc')).toHaveLength(1)
  })

  it('names the profile and the answer when the token endpoint refuses', async () => {
    const { transport } = fakeTransport(() => ({ status: 401, body: { error: 'invalid_client' } }))
    const r = await runRequest(Get.request(), { ...base(), transport })
    expect(r.status).toBe('error')
    expect(r.steps[0]?.error).toBe(
      'Token request for profile "cc" failed (the token endpoint answered 401: invalid_client)',
    )
  })

  it('needs no network and no secret in the mock environment', async () => {
    const { transport, calls } = fakeTransport(() => ({ body: {} }))
    await runRequest(Get.request(), { ...base({ env: 'mock', secrets: undefined }), transport })
    expect(calls.some((c) => c.service === 'auth:cc')).toBe(false)
    expect(calls[0]?.headers.authorization).toBe('Bearer mock-token')
  })

  it('still fetches the token in a --safe run', async () => {
    const { transport, calls } = server()
    const r = await runRequest(Get.request(), { ...base({ readOnly: true }), transport })
    expect(calls.some((c) => c.service === 'auth:cc')).toBe(true)
    expect(r.status).toBe('pass')
  })

  it('wants the client id and secret of the profile a request resolves to', async () => {
    const names = await collectSecretNames(Get.request(), { cc: profile() }, undefined, {
      shop: ['cc'],
    })
    expect([...names].sort()).toEqual(['CLIENT_ID', 'CLIENT_SECRET'])
  })

  it('says what is wrong when the token address cannot be worked out', async () => {
    const { transport } = server()
    const r = await runRequest(Get.request(), { ...base({ vars: {} }), transport })
    expect(r.status).toBe('error')
    expect(r.steps[0]?.error).toContain('has no usable token address')
  })
})

describe('a flow whose list input has a minimum', () => {
  it('runs on its defaults: the list starts at its minimum', async () => {
    const seq = sequence({
      id: 'lists',
      title: 'Lists',
      inputs: { people: c.array(c.object({ name: c.text({ default: 'Ada' }) }), { min: 2 }) },
    })
    const r = await runSequence(seq, {} as never)
    expect(r.status).not.toBe('error')
  })
})

describe('scripts', () => {
  const sign = withMock(
    script({
      id: 'sign',
      name: 'Sign',
      runtime: 'isomorphic',
      inputs: { text: c.text({ default: 'x' }) },
      run: async ({ text }) => ({ signature: `signed:${text}` }),
    }),
    () => ({ signature: 'sig' }),
  )
  const approve = withMock(
    script({
      id: 'approve',
      name: 'Approve',
      runtime: 'browser',
      inputs: { token: c.text(), amount: c.number({ default: 10 }) },
      run: async ({ token, amount }) => ({ nonce: `nonce:${token}`, payerId: `P${amount}` }),
    }),
    () => ({ nonce: 'fake-nonce', payerId: 'FAKE' }),
  )
  const host = (over: Partial<ScriptHost> = {}): ScriptHost => ({
    runtime: 'node',
    fetch: async () => new Response('{}'),
    ...over,
  })
  const getToken = CreateOrder.request({
    data: { itemCode: 'x', quantity: 1 },
    capture: { clientToken: (res) => (res.status === 201 ? res.data.id : '') },
  })

  it('a flow with a script step still lists the secrets of its request steps', async () => {
    const seq = sequence({ id: 's', title: 'S' })
      .step('Create', create.with({ headers: { authorization: 'Bearer {{secrets.ORDER_KEY}}' } }))
      .step('Sign', sign)
    expect(await collectSecretNames(seq)).toEqual(new Set(['ORDER_KEY']))
  })

  it('runs an inline body, captures what it returns and hands it to the next request', async () => {
    const { transport, calls } = fakeOrderApi()
    const seq = sequence({ id: 's', title: 'S' })
      .step('Sign', sign.with({ inputs: { text: 'hello' } }))
      .step('Order', CreateOrder.request({ data: { itemCode: '{{signature}}', quantity: 1 } }))
      .check('typed', (ctx, { assert }) => assert.is(ctx.captured.signature, 'signed:hello'))
    const r = await runSequence(seq, { env: 'live', transport, scripts: host() })
    expect(r.status).toBe('pass')
    expect(r.steps.map((s) => [s.kind, s.status])).toEqual([
      ['script', 'pass'],
      ['request', 'pass'],
      ['check', 'pass'],
    ])
    expect(r.steps[0]?.captured).toEqual({ signature: 'signed:hello' })
    expect(r.steps[0]?.script).toMatchObject({
      id: 'sign',
      runtime: 'isomorphic',
      inputs: { text: 'hello' },
      output: { signature: 'signed:hello' },
    })
    expect(calls[0]?.body).toEqual({ itemCode: 'signed:hello', quantity: 1 })
  })

  it('fills inputs from placeholders that name the flow so far, and says where each came from', async () => {
    const { transport } = fakeOrderApi()
    const seq = sequence({ id: 's', title: 'S', inputs: { amount: c.number({ default: 7 }) } })
      .step('Token', getToken)
      .step('Approve', approve.with({ inputs: { token: '{{clientToken}}', amount: '{{amount}}' } }))
    const r = await runSequence(seq, {
      env: 'live',
      transport,
      scripts: host({ runtime: 'browser' }),
    })
    expect(r.status).toBe('pass')
    // a whole-string placeholder keeps the type: amount is the number 7, not "7"
    expect(r.steps[1]?.script?.inputs).toEqual({ token: 'ord_1', amount: 7 })
    expect(r.steps[1]?.captured).toEqual({ nonce: 'nonce:ord_1', payerId: 'P7' })
    expect(r.steps[1]?.uses?.map((u) => [u.key, u.source, u.step])).toEqual([
      ['clientToken', 'capture', 'Token'],
      ['amount', 'input', undefined],
    ])
  })

  it('does not pick up a value by name: an input nothing gave is its default, or missing', async () => {
    const { transport } = fakeOrderApi()
    const seq = sequence({ id: 's', title: 'S' })
      .step('Token', getToken)
      // `token` is captured by name, but the step does not ask for it, and the control has no default
      .step('Approve', approve)
    const r = await runSequence(seq, {
      env: 'live',
      transport,
      scripts: host({ runtime: 'browser' }),
    })
    expect(r.status).toBe('error')
    expect(r.steps[1]?.error).toContain('Missing input "token"')
    expect(r.steps[1]?.error).toContain('.with({ inputs: { token: ... } })')
  })

  it('runtime overrides decide what a placeholder in an input stands for', async () => {
    const seq = sequence({ id: 's', title: 'S' }).step(
      'Approve',
      approve.with({ inputs: { token: 'a', amount: '{{amount}}' } }),
    )
    const r = await runSequence(seq, {
      env: 'live',
      transport: fakeOrderApi().transport,
      scripts: host({ runtime: 'browser' }),
      vars: { amount: 1 },
      overrides: { amount: 99 },
    })
    expect(r.steps[0]?.script?.inputs).toEqual({ token: 'a', amount: 99 })
  })

  it('refuses a secret placeholder: a script is not handed secrets', async () => {
    const seq = sequence({ id: 's', title: 'S' }).step(
      'Sign',
      sign.with({ inputs: { text: '{{secrets.KEY}}' } }),
    )
    const r = await runSequence(seq, {
      env: 'live',
      transport: fakeOrderApi().transport,
      scripts: host(),
    })
    expect(r.steps[0]?.status).toBe('error')
    expect(r.steps[0]?.error).toContain('cannot be handed secrets')
  })

  it('a value that is not one of the control options fails the step', async () => {
    const pick = script({
      id: 'pick',
      name: 'Pick',
      runtime: 'isomorphic',
      inputs: { size: c.select(['S', 'M'] as const) },
      run: async ({ size }) => ({ size }),
    })
    const seq = sequence({ id: 's', title: 'S' })
      .step('Pick', pick.with({ inputs: { size: '{{size}}' } }))
      .step('After', sign)
    const r = await runSequence(seq, {
      env: 'live',
      transport: fakeOrderApi().transport,
      scripts: host(),
      vars: { size: 'XL' },
    })
    expect(r.steps.map((s) => s.status)).toEqual(['error', 'skipped'])
    expect(r.steps[0]?.error).toContain('not one of the available options')
  })

  it('loads a body only when the step runs, and once per run of the step', async () => {
    let loads = 0
    const lazy = script({
      id: 'lazy',
      name: 'Lazy',
      runtime: 'isomorphic',
      load: async () => {
        loads++
        return { run: async () => ({ ok: true }) }
      },
    })
    const seq = sequence({ id: 's', title: 'S' }).step('Lazy', lazy)
    expect(loads).toBe(0)
    const r = await runSequence(seq, {
      env: 'live',
      transport: fakeOrderApi().transport,
      scripts: host(),
    })
    expect(r.status).toBe('pass')
    expect(loads).toBe(1)
  })

  it('a loader that gives no `run` export is an error that says so', async () => {
    const bad = script({
      id: 'bad',
      name: 'Bad',
      runtime: 'isomorphic',
      load: (async () => ({})) as never,
    })
    const r = await runSequence(sequence({ id: 's', title: 'S' }).step('Bad', bad), {
      env: 'live',
      transport: fakeOrderApi().transport,
      scripts: host(),
    })
    expect(r.steps[0]?.error).toContain('no `run` export')
  })

  describe('time limits', () => {
    const slow = (runtime: 'node' | 'browser') =>
      script({
        id: 'slow',
        runtime: runtime === 'node' ? 'isomorphic' : 'browser',
        run: async () => {
          await new Promise((r) => setTimeout(r, 80))
          return { ok: true }
        },
      })
    const go = (def: ReturnType<typeof slow>, runtime: 'node' | 'browser') =>
      runSequence(sequence({ id: 's', title: 'S' }).step('Slow', def), {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host({ runtime }),
        timeoutMs: 20,
      })

    it('a script in node ends at the run’s time limit when it names none', async () => {
      const r = await go(slow('node'), 'node')
      expect(r.steps[0]?.status).toBe('error')
      expect(r.steps[0]?.error).toMatch(/Timed out after 20ms/)
    })

    it('a script in a page waits as long as a person does', async () => {
      const r = await go(slow('browser'), 'browser')
      expect(r.steps[0]?.status).toBe('pass')
    })
  })

  describe('skip reasons and a script on its own', () => {
    it('say why a flow or a script does not run on a host, and that mock runs all', () => {
      const flow = sequence({ id: 's', title: 'S' }).step(
        'Approve',
        approve.with({ inputs: { token: 'x' } }),
      )
      expect(flowSkipReason(flow, 'node', 'live')).toContain('Needs a browser')
      expect(flowSkipReason(flow, 'browser', 'live')).toBeUndefined()
      expect(flowSkipReason(flow, undefined, 'live')).toContain('no script host')
      expect(flowSkipReason(flow, 'node', 'mock')).toBeUndefined()
      expect(scriptSkipReason(sign, undefined)).toContain('no script host')
      expect(scriptSkipReason(sign, 'node')).toBeUndefined()
      expect(scriptSkipReason(approve, 'node')).toContain('Needs a browser')
    })

    it('runs as a flow of one step: the mock answers on mock, the body gets the inputs live', async () => {
      const flow = scriptFlow(sign)
      expect(flow.meta).toMatchObject({ id: 'sign', title: 'Sign' })
      const mock = await runSequence(flow, { env: 'mock', transport: fakeOrderApi().transport })
      expect(mock.steps[0]?.script?.output).toEqual({ signature: 'sig' })
      const live = await runSequence(flow, {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host(),
        inputs: { text: 'hello' },
      })
      expect(live.status).toBe('pass')
      expect(live.steps[0]?.script?.inputs).toEqual({ text: 'hello' })
      expect(live.steps[0]?.captured).toEqual({ signature: 'signed:hello' })
    })

    it('is skipped as a whole in node when it needs a browser', async () => {
      const r = await runSequence(scriptFlow(approve), {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host(),
      })
      expect(r.skipped).toContain('Needs a browser')
    })

    it('refuses a write of the body in a --safe run', async () => {
      const writer = script({
        id: 'writer',
        runtime: 'isomorphic',
        run: async (_i, h) => {
          await h.fetch('https://x.test/', { method: 'POST' })
          return { ok: true }
        },
      })
      const r = await runSequence(scriptFlow(writer), {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host(),
        readOnly: true,
      })
      expect(r.steps[0]?.error).toContain('--safe')
    })
  })

  describe('where it runs', () => {
    it('a flow that needs a browser is skipped as a whole in node, and counts as passed', async () => {
      const { transport, calls } = fakeOrderApi()
      const seq = sequence({ id: 's', title: 'S' })
        .step('Token', getToken)
        .step('Approve', approve.with({ inputs: { token: 'x' } }))
      const events: string[] = []
      const r = await runSequence(seq, {
        env: 'live',
        transport,
        scripts: host(),
        onEvent: (e) => events.push(e.type),
      })
      expect(calls).toHaveLength(0)
      expect(r.status).toBe('pass')
      expect(r.skipped).toContain('Needs a browser')
      expect(r.steps.map((s) => [s.name, s.status, s.kind])).toEqual([
        ['Token', 'skipped', 'request'],
        ['Approve', 'skipped', 'script'],
      ])
      expect(r.totals).toMatchObject({ steps: 2, skipped: 2, passed: 0 })
      expect(events).toEqual(['run:start', 'done'])
    })

    it('a flow that needs node is skipped in a page', async () => {
      const onNode = withMock(
        script({
          id: 'n',
          name: 'N',
          runtime: 'node',
          run: async () => ({ ok: true }),
        }),
        () => ({ ok: true }),
      )
      const r = await runSequence(sequence({ id: 's', title: 'S' }).step('N', onNode), {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host({ runtime: 'browser' }),
      })
      expect(r.skipped).toContain('Needs node')
    })

    it('a step this host cannot run is skipped before its inputs are looked at', async () => {
      // `token` has no default and nothing gives it: on a host that could run it that is an error, on this one it is no matter
      const seq = sequence({ id: 's', title: 'S' }).step('Approve', () => approve)
      const r = await runSequence(seq, {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host(),
      })
      expect(r.steps[0]).toMatchObject({ status: 'skipped' })
      expect(r.steps[0]?.error).toBeUndefined()
      expect(r.skipped).toContain('Needs a browser')
      const onBrowser = await runSequence(seq, {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host({ runtime: 'browser' }),
      })
      expect(onBrowser.steps[0]?.error).toContain('Missing input "token"')
    })

    it('a flow with no host is skipped as well, and an isomorphic one is not restricted', async () => {
      const seq = sequence({ id: 's', title: 'S' }).step(
        'Approve',
        approve.with({ inputs: { token: 'x' } }),
      )
      const none = await runSequence(seq, { env: 'live', transport: fakeOrderApi().transport })
      expect(none.skipped).toContain('no script host')
      for (const runtime of ['browser', 'node'] as const) {
        const r = await runSequence(sequence({ id: 's', title: 'S' }).step('Sign', sign), {
          env: 'live',
          transport: fakeOrderApi().transport,
          scripts: host({ runtime }),
        })
        expect([r.status, r.skipped]).toEqual(['pass', undefined])
      }
    })

    it('a flow with a step for each runtime only runs on mock', async () => {
      const onNode = withMock(
        script({
          id: 'n',
          name: 'N',
          runtime: 'node',
          run: async () => ({ ok: true }),
        }),
        () => ({ ok: true }),
      )
      const seq = sequence({ id: 's', title: 'S' })
        .step('Approve', approve.with({ inputs: { token: 'x' } }))
        .step('N', onNode)
      for (const runtime of ['browser', 'node'] as const) {
        const r = await runSequence(seq, {
          env: 'live',
          transport: fakeOrderApi().transport,
          scripts: host({ runtime }),
        })
        expect(r.skipped).toContain('needs a browser and one that needs node')
      }
      const mock = await runSequence(seq, { env: 'mock', transport: fakeOrderApi().transport })
      expect([mock.status, mock.skipped]).toEqual(['pass', undefined])
    })

    it('a script step made by a function ends the flow where it is reached: the steps before it ran', async () => {
      const { transport, calls } = fakeOrderApi()
      const seq = sequence({ id: 's', title: 'S' })
        .step('Token', getToken)
        .step('Approve', (ctx) => approve.with({ inputs: { token: ctx.captured.clientToken } }))
        .step('After', getToken)
      const events: string[] = []
      const r = await runSequence(seq, {
        env: 'live',
        transport,
        scripts: host(),
        onEvent: (e) => events.push(e.type === 'step:end' ? `end:${e.name}:${e.status}` : e.type),
      })
      expect(calls).toHaveLength(1)
      expect(r.steps.map((s) => s.status)).toEqual(['pass', 'skipped', 'skipped'])
      expect(r.steps[1]?.note).toContain('Needs a browser')
      expect(r.steps[2]?.note).toContain('Needs a browser')
      expect(r.skipped).toBeUndefined()
      expect(r.status).toBe('pass')
      // the skip of the script itself is seen as it happens, as a step that ended
      expect(events).toContain('end:Approve:skipped')
    })
  })

  describe('the mock environment', () => {
    it('answers from the mock in any host, and never loads the body', async () => {
      let loaded = false
      const lazy = withMock(
        script({
          id: 'pay',
          name: 'Pay',
          runtime: 'browser',
          inputs: { token: c.text() },
          load: async () => {
            loaded = true
            return { run: async () => ({ nonce: 'real' }) }
          },
        }),
        () => ({ nonce: 'fake-nonce' }),
      )
      const seq = sequence({ id: 's', title: 'S' })
        .step('Token', getToken)
        .step('Pay', lazy.with({ inputs: { token: '{{clientToken}}' } }))
        .step('Order', CreateOrder.request({ data: { itemCode: '{{nonce}}', quantity: 1 } }))
      const { transport, calls } = fakeOrderApi()
      const r = await runSequence(seq, { env: 'mock', transport })
      expect(r.status).toBe('pass')
      expect(r.skipped).toBeUndefined()
      expect(loaded).toBe(false)
      expect(r.steps[1]?.captured).toEqual({ nonce: 'fake-nonce' })
      expect(r.steps[1]?.script?.inputs).toEqual({ token: 'ord_1' })
      expect(calls[1]?.body).toEqual({ itemCode: 'fake-nonce', quantity: 1 })
    })

    it('a withMock hook answers from the inputs, and throwing fails the step', async () => {
      const shaped = withMock(approve, (req) => {
        if (req.inputs.token === 'bad') throw new Error('the sandbox said no')
        return { nonce: `fake-${req.inputs.token}`, payerId: `PAYER-${req.inputs.amount}` }
      })
      const run = (token: string) =>
        runSequence(
          sequence({ id: 's', title: 'S' }).step('Approve', shaped.with({ inputs: { token } })),
          {
            env: 'mock',
            transport: fakeOrderApi().transport,
          },
        )
      const ok = await run('t')
      expect(ok.steps[0]?.captured).toEqual({ nonce: 'fake-t', payerId: 'PAYER-10' })
      const bad = await run('bad')
      expect(bad.steps[0]).toMatchObject({ status: 'error', error: 'the sandbox said no' })
    })

    it('a mock may wait, and stopping ends the wait', async () => {
      const slow = withMock(sign, (_req, res) => {
        res.delayMs = 5_000
        return { signature: 'sig' }
      })
      const ctl = new AbortController()
      const run = runSequence(sequence({ id: 's', title: 'S' }).step('Sign', slow), {
        env: 'mock',
        transport: fakeOrderApi().transport,
        signal: ctl.signal,
      })
      setTimeout(() => ctl.abort(), 10)
      const r = await run
      expect(r.steps[0]).toMatchObject({
        status: 'error',
        error: 'Stopped before the step finished.',
      })
    })

    it('a script with no withMock is an error on mock that names the fix', async () => {
      const bare = script({
        id: 'bare',
        name: 'Bare',
        runtime: 'isomorphic',
        run: async () => ({ ok: true }),
      })
      const r = await runSequence(sequence({ id: 's', title: 'S' }).step('Bare', bare), {
        env: 'mock',
        transport: fakeOrderApi().transport,
      })
      expect(r.steps[0]?.status).toBe('error')
      expect(r.steps[0]?.error).toContain('has no mock')
      expect(r.steps[0]?.error).toContain('withMock(')
    })

    it('a mock that does not answer with an object is an error', async () => {
      const odd = withMock(
        script({ id: 'odd', name: 'Odd', run: async () => ({ ok: true }) }),
        (() => 'nope') as never,
      )
      const r = await runSequence(sequence({ id: 's', title: 'S' }).step('Odd', odd), {
        env: 'mock',
        transport: fakeOrderApi().transport,
      })
      expect(r.steps[0]?.error).toContain('must return an object, and so must its mock')
    })
  })

  describe('what the body is given', () => {
    const body = (fn: ScriptBody<{ n: number }, { ok: boolean }>) =>
      script({
        id: 'b',
        name: 'B',
        runtime: 'isomorphic',
        inputs: { n: c.number({ default: 1 }) },
        run: fn,
      })
    const runBody = (
      def: ReturnType<typeof body>,
      o: Partial<Parameters<typeof runSequence>[1]> = {},
    ) =>
      runSequence(sequence({ id: 's', title: 'S' }).step('B', def), {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host(),
        ...o,
      })

    it('records the checks of the contract, and a failed one fails the step', async () => {
      const r = await runBody(
        script({
          id: 'checked',
          name: 'Checked',
          runtime: 'isomorphic',
          inputs: { n: c.number({ default: 1 }) },
          run: async () => ({ ok: true }),
          assert: (_out, { assert, inputs }) => {
            assert.is(inputs.n, 1, 'one')
            assert.is(inputs.n, 2, 'two')
          },
        }),
      )
      expect(r.status).toBe('fail')
      expect(r.steps[0]?.assertions.map((a) => [a.label, a.pass])).toEqual([
        ['one', true],
        ['two', false],
      ])
    })

    it('a hard run ends the contract assert at the first failed check, without calling it an error', async () => {
      let after = false
      const r = await runBody(
        script({
          id: 'hard',
          name: 'Hard',
          runtime: 'isomorphic',
          run: async () => ({ ok: true }),
          assert: (_out, { assert }) => {
            assert.is(1, 2, 'nope')
            after = true
          },
        }),
        { assertMode: 'hard' },
      )
      expect(after).toBe(false)
      expect(r.steps[0]?.status).toBe('fail')
      expect(r.steps[0]?.error).toBeUndefined()
    })

    it('the contract assert sees the output, the inputs and what was captured', async () => {
      const checked = script({
        id: 'c',
        name: 'C',
        runtime: 'isomorphic',
        inputs: { n: c.number({ default: 3 }) },
        run: async ({ n }) => ({ double: n * 2 }),
        capture: { twice: (out) => out.double },
        assert: (out, { assert, inputs, vars }) => {
          assert.is(out.double, inputs.n * 2, 'doubled')
          assert.is(vars.twice, 6, 'captured')
        },
      })
      const r = await runSequence(sequence({ id: 's', title: 'S' }).step('C', checked), {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host(),
      })
      expect(r.steps[0]?.captured).toEqual({ twice: 6 })
      expect(r.steps[0]?.assertions.map((a) => [a.label, a.pass])).toEqual([
        ['doubled', true],
        ['captured', true],
      ])
    })

    it('keeps what it logs, and tells the listener as it happens', async () => {
      const lines: string[] = []
      const r = await runBody(
        body(async (_i, h) => {
          h.log('loading the sdk')
          h.log('rendered')
          return { ok: true }
        }),
        { onEvent: (e) => e.type === 'script:log' && lines.push(e.message) },
      )
      expect(lines).toEqual(['loading the sdk', 'rendered'])
      expect(r.steps[0]?.script?.logs).toEqual(['loading the sdk', 'rendered'])
    })

    it('must return an object', async () => {
      const r = await runBody(body((async () => 'nope') as never))
      expect(r.steps[0]?.status).toBe('error')
      expect(r.steps[0]?.error).toContain('must return an object')
    })

    it('an error it throws fails the step with its message, and a hint is kept for the page', async () => {
      const r = await runBody(
        body(async () => {
          throw Object.assign(new Error('blocked'), {
            hint: { code: 'cors', origin: 'https://sdk.example' },
          })
        }),
      )
      expect(r.steps[0]).toMatchObject({
        status: 'error',
        error: 'blocked',
        errorHint: { code: 'cors', origin: 'https://sdk.example' },
      })
    })

    it('has the host fetch, its kind, the env and the flow vars', async () => {
      const seen: unknown[] = []
      const r = await runBody(
        body(async (_i, h) => {
          const res = await h.fetch('https://api.example/x')
          seen.push(h.runtime, h.env, h.vars.region, await res.text())
          return { ok: true }
        }),
        {
          vars: { region: 'eu' },
          scripts: host({ runtime: 'node', fetch: async () => new Response('hello') }),
        },
      )
      expect(r.status).toBe('pass')
      expect(seen).toEqual(['node', 'live', 'eu', 'hello'])
    })

    it('mount and loadScript are the host’s, and say so when it has none', async () => {
      const r = await runBody(
        body(async (_i, h) => {
          await h.mount()
          return { ok: true }
        }),
      )
      expect(r.steps[0]?.error).toContain('needs a place on the page')
      const el = { tag: 'div' }
      const r2 = await runBody(
        body(async (_i, h) => {
          const target = await h.mount()
          const sdk = await h.loadScript('https://sdk.example/x.js', { global: 'sdk' })
          return { ok: target === (el as never) && sdk === 'the-sdk' }
        }),
        {
          scripts: host({
            runtime: 'browser',
            mount: async () => el as never,
            loadScript: async () => 'the-sdk',
          }),
        },
      )
      expect(r2.steps[0]?.captured).toEqual({ ok: true })
    })

    it('stopping the run ends a body that waits, and tells the body', async () => {
      const ctl = new AbortController()
      let told = false
      const run = runBody(
        body(
          (_i, h) =>
            new Promise(() => {
              h.signal?.addEventListener('abort', () => {
                told = true
              })
            }),
        ),
        { signal: ctl.signal },
      )
      setTimeout(() => ctl.abort(), 10)
      const r = await run
      expect(told).toBe(true)
      expect(r.steps[0]).toMatchObject({
        status: 'error',
        error: 'Stopped before the step finished.',
      })
    })

    it('stopping while the body is still being loaded does not leave an unhandled rejection', async () => {
      const ctl = new AbortController()
      const slow = script({
        id: 'slow',
        name: 'Slow',
        runtime: 'isomorphic',
        load: async () => {
          await new Promise((done) => setTimeout(done, 30))
          return { run: async () => ({ ok: true }) }
        },
      })
      const unhandled: unknown[] = []
      const on = (e: unknown) => unhandled.push(e)
      // core's tests are checked without node's types
      const proc = (
        globalThis as unknown as {
          process: { on(e: string, f: typeof on): void; off(e: string, f: typeof on): void }
        }
      ).process
      proc.on('unhandledRejection', on)
      setTimeout(() => ctl.abort(), 5)
      const r = await runSequence(sequence({ id: 's', title: 'S' }).step('Slow', slow), {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host(),
        signal: ctl.signal,
      })
      await new Promise((done) => setTimeout(done, 20))
      proc.off('unhandledRejection', on)
      expect(unhandled).toEqual([])
      expect(r.steps[0]?.status).toBe('error')
    })

    it('a script with a timeout ends when it passes', async () => {
      const limited = script({
        id: 'limited',
        name: 'Limited',
        runtime: 'isomorphic',
        timeoutMs: 20,
        run: () => new Promise<{ ok: boolean }>(() => {}),
      })
      const r = await runSequence(sequence({ id: 's', title: 'S' }).step('L', limited), {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host(),
      })
      expect(r.steps[0]).toMatchObject({ status: 'error', error: 'Timed out after 20ms.' })
    })
  })

  describe('a script that needs a browser, run in node', () => {
    const throwing = (error: unknown) =>
      script({
        id: 'sdk',
        name: 'Sdk',
        runtime: 'isomorphic',
        run: async () => {
          throw error
        },
      })
    const run = async (error: unknown, runtime: 'node' | 'browser' = 'node') =>
      (
        await runSequence(sequence({ id: 's', title: 'S' }).step('Sdk', throwing(error)), {
          env: 'live',
          transport: fakeOrderApi().transport,
          scripts: host({ runtime }),
        })
      ).steps[0]

    it('is told what is missing, and what to do about it', async () => {
      for (const name of ['document', 'navigator', 'localStorage', 'XMLHttpRequest']) {
        const step = await run(new ReferenceError(`${name} is not defined`))
        expect(step?.status).toBe('error')
        expect(step?.error).toContain(`${name} is not defined. This script uses \`${name}\``)
        expect(step?.error).toContain('which a run in node does not have')
        expect(step?.error).toContain("give it runtime: 'browser'")
      }
    })

    it('is told too when the file failed to load, whose message begins with where', async () => {
      const step = await run(
        new Error('Could not run https://sdk.example/x.js: document is not defined'),
      )
      expect(step?.error).toContain(
        'Could not run https://sdk.example/x.js: document is not defined. This script uses `document`',
      )
    })

    it('is told for an error from another realm, which is no Error here but has a name and a message', async () => {
      const step = await run({ name: 'ReferenceError', message: 'document is not defined' })
      expect(step?.error).toContain('document is not defined. This script uses `document`')
    })

    it('leaves alone a name that is not a browser one, a different failure, and a browser host', async () => {
      expect((await run(new ReferenceError('thing is not defined')))?.error).toBe(
        'thing is not defined',
      )
      expect((await run(new Error('the key is wrong')))?.error).toBe('the key is wrong')
      expect((await run('plain text'))?.error).toBe('plain text')
      // in a page those names exist, so a failure there is something else
      expect((await run(new ReferenceError('document is not defined'), 'browser'))?.error).toBe(
        'document is not defined',
      )
      // and a name that merely contains one is no match
      expect((await run(new ReferenceError('mydocument is not defined')))?.error).toBe(
        'mydocument is not defined',
      )
    })
  })

  describe('--safe', () => {
    const poster = (safe: boolean) =>
      script({
        id: 'poster',
        name: 'Poster',
        runtime: 'node',
        safe,
        run: async (_i, h) => {
          const res = await h.fetch('https://api.example/charge', { method: 'POST' })
          return { status: res.status }
        },
      })
    const go = (def: ReturnType<typeof poster>, readOnly: boolean) =>
      runSequence(sequence({ id: 's', title: 'S' }).step('Post', def), {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host({ fetch: async () => new Response('{}', { status: 201 }) }),
        readOnly,
      })

    it('refuses a write unless the script says it only reads', async () => {
      const refused = await go(poster(false), true)
      expect(refused.steps[0]?.status).toBe('error')
      expect(refused.steps[0]?.error).toContain('Refusing POST https://api.example/charge')
      expect(refused.steps[0]?.error).toContain('safe: true')
      expect((await go(poster(true), true)).steps[0]?.captured).toEqual({ status: 201 })
      expect((await go(poster(false), false)).steps[0]?.captured).toEqual({ status: 201 })
    })

    it('always lets a read through', async () => {
      const reader = script({
        id: 'reader',
        name: 'Reader',
        runtime: 'node',
        run: async (_i, h) => {
          await h.fetch('https://api.example/x')
          await h.fetch(new Request('https://api.example/y', { method: 'HEAD' }))
          return { ok: true }
        },
      })
      const r = await runSequence(sequence({ id: 's', title: 'S' }).step('R', reader), {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host(),
        readOnly: true,
      })
      expect(r.status).toBe('pass')
    })
  })

  describe('reports', () => {
    it('masks a secret the run holds wherever a script shows it', async () => {
      const leaky = script({
        id: 'leaky',
        name: 'Leaky',
        runtime: 'isomorphic',
        inputs: { text: c.text({ default: 'x' }) },
        run: async ({ text }, h) => {
          h.log(`got ${text}`)
          return { echoed: text }
        },
      })
      const events: string[] = []
      const r = await runSequence(
        sequence({ id: 's', title: 'S' }).step(
          'Leaky',
          leaky.with({ inputs: { text: 'sk_live_abcdef' } }),
        ),
        {
          env: 'live',
          transport: fakeOrderApi().transport,
          scripts: host(),
          secrets: { KEY: 'sk_live_abcdef' },
          onEvent: (e) => events.push(JSON.stringify(e)),
        },
      )
      expect(JSON.stringify(r)).not.toContain('sk_live_abcdef')
      expect(events.join('')).not.toContain('sk_live_abcdef')
    })

    it('redacts the inputs and the output of a script that look like credentials', async () => {
      const login = script({
        id: 'login',
        name: 'Login',
        runtime: 'isomorphic',
        inputs: { password: c.text({ default: 'hunter2' }) },
        run: async () => ({ accessToken: 'abc123', nonce: 'n1' }),
      })
      const r = await runSequence(sequence({ id: 's', title: 'S' }).step('Login', login), {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host(),
      })
      const [clean] = redactResults([r])
      expect(clean?.steps[0]?.script?.inputs).toEqual({ password: '***' })
      expect(clean?.steps[0]?.script?.output).toEqual({ accessToken: '***', nonce: 'n1' })
      expect(JSON.stringify(clean)).not.toContain('hunter2')
      expect(JSON.stringify(clean)).not.toContain('abc123')
    })

    it('a failed script shows what it was given, what it said and what it returned', async () => {
      const failing = script({
        id: 'failing',
        name: 'Failing',
        runtime: 'isomorphic',
        inputs: { amount: c.number({ default: 5 }) },
        run: async (_i, h) => {
          h.log('rendering')
          return { ok: false }
        },
        assert: (out, { assert }) => assert.ok(out.ok, 'approved'),
      })
      const r = await runSequence(sequence({ id: 's', title: 'S' }).step('Failing', failing), {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host(),
      })
      const lines = traceLines(r.steps[0] as never)
      expect(lines[0]).toBe('Script    failing (isomorphic)')
      expect(lines.join('\n')).toContain('"amount": 5')
      expect(lines.join('\n')).toContain('rendering')
      expect(lines.join('\n')).toContain('"ok": false')
    })

    it('says a skipped flow once, and counts it as skipped, not passed', async () => {
      const seq = sequence({ id: 's', title: 'Checkout' }).step(
        'Approve',
        approve.with({ inputs: { token: 'x' } }),
      )
      const r = await runSequence(seq, {
        env: 'live',
        transport: fakeOrderApi().transport,
        scripts: host(),
      })
      const text = formatList([r])
      expect(text).toContain('– Checkout  skipped: Needs a browser')
      expect(text).not.toContain('Checkout › Approve')
      expect(text).toContain('1 skipped')
      expect(text).not.toContain('1 passed')
      expect(exitCode([r])).toBe(0)
      expect(testExitCode([r])).toBe(0)
      expect(toJUnit([r])).toContain('<skipped/>')
      const out: string[] = []
      const rep = createListReporter({ write: (t) => out.push(t) })
      rep.onEvent({ type: 'done', result: r })
      expect(out.join('')).toContain('– Checkout  skipped: Needs a browser')
    })
  })
})
