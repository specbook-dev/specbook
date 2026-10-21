import { describe, expect, it } from 'vitest'
import { handleWireFetch, parseWireCall, REFUSAL_HEADER, type WireCall } from '../src'

type Fetch = typeof fetch
const fetchCall = (url: string, init: Partial<Extract<WireCall, { type: 'fetch' }>['req']> = {}) =>
  ({
    v: 1,
    type: 'fetch',
    id: 'c1',
    req: { method: 'GET', url, headers: {}, ...init },
  }) as Extract<WireCall, { type: 'fetch' }>
const allow = { allow: () => true }
const answer = (status: number, body: string, headers: Record<string, string> = {}): Fetch =>
  (async () => new Response(body, { status, headers })) as Fetch

describe('the API’s own answer is an answer, whatever its status', () => {
  it.each([
    [403, '{"message":"forbidden by the API"}'],
    [413, 'payload too large, says the API'],
    [502, 'bad gateway from the API'],
    [504, 'gateway timeout from the API'],
    [400, '{"error":"Missing secrets: nothing to do with us"}'],
  ])('passes a %i through to the page', async (status, body) => {
    const r = await handleWireFetch(fetchCall('https://api.example.com/x'), {
      ...allow,
      fetch: answer(status, body, { 'content-type': 'application/json' }),
    })
    expect(r.type).toBe('response')
    if (r.type === 'response') expect(r.res.status).toBe(status)
  })

  it('does not let an API pass itself off as one of our refusals', async () => {
    const r = await handleWireFetch(fetchCall('https://api.example.com/x'), {
      ...allow,
      fetch: answer(200, 'ok', { [REFUSAL_HEADER]: 'blocked' }),
    })
    expect(r.type).toBe('response')
    if (r.type === 'response') expect(r.res.headers[REFUSAL_HEADER]).toBeUndefined()
  })

  it('passes a real 3xx (as Node gives one) through, with its Location', async () => {
    const r = await handleWireFetch(fetchCall('https://api.example.com/x'), {
      ...allow,
      fetch: answer(302, '', { location: 'https://api.example.com/y' }),
    })
    expect(r).toMatchObject({ type: 'response', res: { status: 302 } })
  })
})

describe('what is refused here is an error with a code', () => {
  it('a method outside the allowed ones', async () => {
    const r = await handleWireFetch(fetchCall('https://api.example.com/x', { method: 'DELETE' }), {
      ...allow,
      policy: { methods: ['GET'] },
      fetch: answer(200, 'unreachable'),
    })
    expect(r).toMatchObject({ type: 'error', code: 'blocked' })
  })

  it('a body over the limit', async () => {
    const r = await handleWireFetch(
      fetchCall('https://api.example.com/x', {
        method: 'POST',
        body: { kind: 'text', text: 'x'.repeat(100) },
      }),
      { ...allow, policy: { maxBodyBytes: 10 }, fetch: answer(200, 'unreachable') },
    )
    expect(r).toMatchObject({ type: 'error', code: 'too-large' })
  })

  it('an upstream that never answers, as a timeout', async () => {
    const hang: Fetch = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () =>
          rej(new DOMException('aborted', 'AbortError')),
        )
      })) as Fetch
    const r = await handleWireFetch(fetchCall('https://api.example.com/x'), {
      ...allow,
      policy: { timeoutMs: 30 },
      fetch: hang,
    })
    expect(r).toMatchObject({ type: 'error', code: 'timeout' })
  })

  it('a network failure', async () => {
    const down: Fetch = (async () => {
      throw new TypeError('connect ECONNREFUSED')
    }) as Fetch
    const r = await handleWireFetch(fetchCall('https://api.example.com/x'), {
      ...allow,
      fetch: down,
    })
    expect(r).toMatchObject({ type: 'error', code: 'network', message: 'connect ECONNREFUSED' })
  })

  it('a missing secret, naming it', async () => {
    const r = await handleWireFetch(
      fetchCall('https://api.example.com/x', {
        headers: { authorization: 'Bearer {{secrets.KEY}}' },
      }),
      { ...allow, fetch: answer(200, 'unreachable') },
    )
    expect(r).toMatchObject({
      type: 'error',
      code: 'missing-secrets',
      message: 'Missing secrets: KEY',
    })
  })

  it('a redirect, which a browser reports as an opaque response, and says what to do', async () => {
    const opaque = (async () => ({
      type: 'opaqueredirect',
      status: 0,
      headers: new Headers(),
      body: null,
    })) as unknown as Fetch
    const r = await handleWireFetch(fetchCall('https://api.example.com/x'), {
      ...allow,
      fetch: opaque,
    })
    expect(r).toMatchObject({ type: 'error', code: 'redirect' })
    if (r.type === 'error') expect(r.message).toMatch(/redirect/i)
  })

  it('a call the caller aborted', async () => {
    const hang: Fetch = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () =>
          rej(new DOMException('aborted', 'AbortError')),
        )
      })) as Fetch
    const ctl = new AbortController()
    const pending = handleWireFetch(
      fetchCall('https://api.example.com/x'),
      { ...allow, fetch: hang },
      ctl.signal,
    )
    setTimeout(() => ctl.abort(), 10)
    expect(await pending).toMatchObject({ type: 'error', code: 'aborted' })
  })
})

describe('the outbound call', () => {
  it('never carries the browser’s cookies for the API', async () => {
    let seen: RequestInit | undefined
    const spy: Fetch = (async (_u: unknown, init?: RequestInit) => {
      seen = init
      return new Response('ok')
    }) as Fetch
    await handleWireFetch(fetchCall('https://api.example.com/x'), { ...allow, fetch: spy })
    expect(seen?.credentials).toBe('omit')
    expect(seen?.redirect).toBe('manual')
  })
})

describe('parseWireCall', () => {
  const ok = (v: unknown) => expect(parseWireCall(v)).toBeDefined()
  const no = (v: unknown) => expect(parseWireCall(v)).toBeUndefined()

  it('accepts the messages of this version, keeping only known fields', () => {
    ok({ v: 1, type: 'ping' })
    expect(parseWireCall({ v: 1, type: 'ping', uiVersion: '1.2.3', evil: 1 })).toEqual({
      v: 1,
      type: 'ping',
      uiVersion: '1.2.3',
    })
    expect(
      parseWireCall({
        v: 1,
        type: 'status',
        apiOrigins: ['https://a.example', 'https://a.example'],
      }),
    ).toEqual({ v: 1, type: 'status', apiOrigins: ['https://a.example'] })
    // a question about changes is an added field: a call without it means what it always did
    expect(
      parseWireCall({ v: 1, type: 'grant', apiOrigins: ['https://a.example'], writes: true }),
    ).toEqual({ v: 1, type: 'grant', apiOrigins: ['https://a.example'], writes: true })
    expect(
      parseWireCall({ v: 1, type: 'grant', apiOrigins: ['https://a.example'], writes: 'yes' }),
    ).toEqual({ v: 1, type: 'grant', apiOrigins: ['https://a.example'] })
    expect(
      parseWireCall({ v: 1, type: 'status', apiOrigins: ['https://a.example'], writes: true }),
    ).toEqual({ v: 1, type: 'status', apiOrigins: ['https://a.example'] })
    ok({ v: 1, type: 'abort', id: 'c1' })
    expect(
      parseWireCall({
        v: 1,
        type: 'fetch',
        id: 'c1',
        req: {
          method: 'post',
          url: 'https://a.example/x?q=1',
          headers: { a: 'b' },
          body: { kind: 'text', text: 'hi' },
        },
      }),
    ).toMatchObject({ type: 'fetch', req: { method: 'POST', body: { kind: 'text', text: 'hi' } } })
  })

  it('refuses what a page could send to confuse the extension', () => {
    no(null)
    no('fetch')
    no({ v: 2, type: 'ping' })
    no({ v: 1, type: 'launch' })
    no({ v: 1, type: 'status', apiOrigins: 'https://a.example' })
    no({ v: 1, type: 'status', apiOrigins: ['https://a.example/with/a/path'] })
    no({ v: 1, type: 'status', apiOrigins: ['javascript:alert(1)'] })
    no({
      v: 1,
      type: 'status',
      apiOrigins: Array.from({ length: 40 }, (_, i) => `https://a${i}.example`),
    })
    no({
      v: 1,
      type: 'fetch',
      id: 'c',
      req: { method: 'GET', url: 'file:///etc/passwd', headers: {} },
    })
    no({
      v: 1,
      type: 'fetch',
      id: 'c',
      req: { method: 'GE T', url: 'https://a.example', headers: {} },
    })
    no({
      v: 1,
      type: 'fetch',
      id: 'c',
      req: { method: 'GET', url: 'https://a.example', headers: { a: 1 } },
    })
    no({
      v: 1,
      type: 'fetch',
      id: 'c',
      req: { method: 'GET', url: 'https://a.example', headers: [] },
    })
    no({
      v: 1,
      type: 'fetch',
      id: 'c',
      req: {
        method: 'POST',
        url: 'https://a.example',
        headers: {},
        body: { kind: 'text', text: 3 },
      },
    })
    no({
      v: 1,
      type: 'fetch',
      id: 'x'.repeat(200),
      req: { method: 'GET', url: 'https://a.example', headers: {} },
    })
  })
})
