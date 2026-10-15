import { describe, expect, it } from 'vitest'
import {
  crossSiteProblem,
  forward,
  handleProxy,
  handleWireFetch,
  isPrivateAddress,
  parseRoute,
  requestToWire,
  secretNames,
  substituteBytes,
  substituteText,
  upstreamProblem,
  wireToRequest,
} from '../src'

const bytes = (...n: number[]) => new Uint8Array(n)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
/** Whether `needle` occurs in `hay`, byte for byte. */
const contains = (hay: Uint8Array, needle: Uint8Array) => hex(hay).includes(hex(needle))
const ascii = (s: string) => new TextEncoder().encode(s)

describe('substituteBytes', () => {
  it('replaces placeholders and leaves every other byte alone', () => {
    const body = new Uint8Array([0xff, 0x00, ...ascii('{{secrets.KEY}}'), 0x80, 0xfe])
    const out = substituteBytes(body, new Map([['KEY', 'sk_123']]))
    expect(hex(out)).toBe(hex(new Uint8Array([0xff, 0x00, ...ascii('sk_123'), 0x80, 0xfe])))
  })

  it('is byte-exact when nothing is substituted, and returns the same array', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0xa0)
    expect(substituteBytes(png, new Map([['KEY', 'x']]))).toBe(png)
  })

  it('accepts spaces inside the braces and the characters a name may hold', () => {
    const t = '{{ secrets.MY-KEY_2 }} and {{secrets.$x}}'
    expect(secretNames(ascii(t))).toEqual(['MY-KEY_2', '$x'])
    expect(
      substituteText(
        t,
        new Map([
          ['MY-KEY_2', 'a'],
          ['$x', 'b'],
        ]),
      ),
    ).toBe('a and b')
  })

  it('leaves unknown names and things that only look like placeholders', () => {
    const t = '{{secrets.NOPE}} {{vars.x}} {{secrets.}} {{secrets.A'
    expect(substituteText(t, new Map([['KEY', 'x']]))).toBe(t)
  })

  it('inserts a value as UTF-8, whatever surrounds it', () => {
    const out = substituteBytes(
      new Uint8Array([0xff, ...ascii('{{secrets.K}}')]),
      new Map([['K', 'pässword']]),
    )
    expect(hex(out)).toBe(hex(new Uint8Array([0xff, ...new TextEncoder().encode('pässword')])))
  })
})

describe('upstream policy', () => {
  it('refuses private, loopback and link-local addresses unless allowed', () => {
    for (const u of [
      'http://127.0.0.1/x',
      'http://localhost:3000',
      'https://169.254.169.254/latest/meta-data',
      'http://10.0.0.5',
      'http://192.168.1.1',
      'http://172.20.0.1',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[::ffff:127.0.0.1]/',
      'https://db.internal/',
      'https://user:pw@api.example.com/',
      'ftp://api.example.com',
    ])
      expect(upstreamProblem(u), u).toBeTruthy()
    expect(upstreamProblem('https://api.example.com/v1')).toBeUndefined()
    expect(upstreamProblem('http://localhost:4001', { allowPrivateHosts: true })).toBeUndefined()
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
  })

  it('refuses a request a browser marks cross-site, and one from another origin', () => {
    const url = new URL('http://localhost:5173/__specbook/proxy/live/x/y')
    expect(crossSiteProblem(new Headers({ 'sec-fetch-site': 'cross-site' }), url)).toBeTruthy()
    expect(crossSiteProblem(new Headers({ origin: 'https://evil.example' }), url)).toBeTruthy()
    expect(crossSiteProblem(new Headers({ origin: 'null' }), url)).toBeTruthy()
    expect(crossSiteProblem(new Headers({ 'sec-fetch-site': 'same-origin' }), url)).toBeUndefined()
    expect(crossSiteProblem(new Headers({ origin: 'http://localhost:5173' }), url)).toBeUndefined()
    // a script or curl sends neither
    expect(crossSiteProblem(new Headers(), url)).toBeUndefined()
  })
})

describe('parseRoute', () => {
  it('splits env, service and the rest', () => {
    expect(parseRoute('/__specbook/proxy/live/petstore/pet/7', '/__specbook/proxy')).toEqual({
      env: 'live',
      service: 'petstore',
      rest: '/pet/7',
    })
    expect(parseRoute('/_api/live/svc', '/_api/')).toEqual({
      env: 'live',
      service: 'svc',
      rest: '/',
    })
    expect(parseRoute('/other/live/svc', '/_api')).toBeUndefined()
    expect(parseRoute('/_api/live', '/_api')).toBeUndefined()
  })
})

interface Seen {
  url: string
  method: string
  headers: Headers
  body: Uint8Array
  redirect?: RequestRedirect
}

function upstream(reply?: (r: Seen) => Response) {
  const seen: Seen[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? new Uint8Array(init.body as Uint8Array) : new Uint8Array()
    const r: Seen = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body,
      redirect: init?.redirect,
    }
    seen.push(r)
    return (
      reply?.(r) ?? new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    )
  }) as unknown as typeof globalThis.fetch
  return { seen, fetch }
}

const policy = {
  upstream: (env: string, service: string) =>
    env === 'live' && service === 'svc' ? 'https://api.example.com/v1' : undefined,
}
const lookup = (name: string) => ({ KEY: 'sk_real', OTHER: 'o' })[name as 'KEY' | 'OTHER']
const route = (path: string, init?: RequestInit) =>
  new Request(`http://localhost:5173/__specbook/proxy${path}`, init)

describe('handleProxy', () => {
  it('is not its own for other URLs', async () => {
    const { fetch } = upstream()
    expect(
      await handleProxy(new Request('http://x/other'), {
        mount: '/__specbook/proxy',
        policy,
        fetch,
      }),
    ).toBeUndefined()
  })

  it('substitutes secrets in headers, query and body, and forwards to the configured base', async () => {
    const u = upstream()
    const res = await handleProxy(
      route('/live/svc/pets?k={{secrets.KEY}}&n=1', {
        method: 'POST',
        headers: { 'x-api-key': '{{secrets.KEY}}', 'content-type': 'application/json' },
        body: JSON.stringify({ f: '{{secrets.OTHER}}' }),
      }),
      { mount: '/__specbook/proxy', policy, lookup, fetch: u.fetch },
    )
    expect(res?.status).toBe(200)
    expect(u.seen[0]?.url).toBe('https://api.example.com/v1/pets?k=sk_real&n=1')
    expect(u.seen[0]?.headers.get('x-api-key')).toBe('sk_real')
    expect(new TextDecoder().decode(u.seen[0]?.body)).toBe('{"f":"o"}')
  })

  it('percent-encodes a value placed in a query string', async () => {
    const u = upstream()
    await handleProxy(route('/live/svc/x?k={{secrets.ODD}}'), {
      mount: '/__specbook/proxy',
      policy,
      lookup: (n) => (n === 'ODD' ? 'a&b+c' : undefined),
      fetch: u.fetch,
    })
    expect(u.seen[0]?.url).toBe('https://api.example.com/v1/x?k=a%26b%2Bc')
  })

  it('forwards an upload byte for byte, and a multipart body with its boundary', async () => {
    const u = upstream()
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0xa0)
    await handleProxy(
      route('/live/svc/pet/7/uploadImage', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: png,
      }),
      { mount: '/__specbook/proxy', policy, lookup, fetch: u.fetch },
    )
    expect(hex(u.seen[0]?.body as Uint8Array)).toBe(hex(png))
    expect(u.seen[0]?.headers.get('content-type')).toBe('application/octet-stream')

    const form = new FormData()
    form.append('file', new Blob([png], { type: 'image/png' }), 'a.png')
    const req = route('/live/svc/pet/7/photo', { method: 'POST', body: form })
    const boundary = /boundary=(.+)$/.exec(req.headers.get('content-type') ?? '')?.[1]
    await handleProxy(req, { mount: '/__specbook/proxy', policy, lookup, fetch: u.fetch })
    const sent = u.seen[1]?.body as Uint8Array
    expect(contains(sent, png)).toBe(true)
    expect(contains(sent, new TextEncoder().encode(`--${boundary}`))).toBe(true)
  })

  it('answers 404 for an unknown service or environment and 400 naming the missing secrets', async () => {
    const u = upstream()
    const deps = { mount: '/__specbook/proxy', policy, lookup, fetch: u.fetch }
    expect((await handleProxy(route('/live/nope/x'), deps))?.status).toBe(404)
    expect((await handleProxy(route('/prod/svc/x'), deps))?.status).toBe(404)
    const r = await handleProxy(route('/live/svc/x', { headers: { a: '{{secrets.NOPE}}' } }), deps)
    expect(r?.status).toBe(400)
    expect(await r?.text()).toContain('NOPE')
    expect(u.seen).toHaveLength(0)
  })

  it('refuses cross-site requests, disallowed methods, oversized bodies and private upstreams', async () => {
    const u = upstream()
    const deps = { mount: '/__specbook/proxy', policy, lookup, fetch: u.fetch }
    const cross = await handleProxy(
      route('/live/svc/x', { headers: { 'sec-fetch-site': 'cross-site' } }),
      deps,
    )
    expect(cross?.status).toBe(403)
    const readOnly = await handleProxy(route('/live/svc/x', { method: 'DELETE' }), {
      ...deps,
      policy: { ...policy, methods: ['GET'] },
    })
    expect(readOnly?.status).toBe(405)
    const big = await handleProxy(
      route('/live/svc/x', { method: 'POST', body: new Uint8Array(20) }),
      {
        ...deps,
        policy: { ...policy, maxBodyBytes: 10 },
      },
    )
    expect(big?.status).toBe(413)
    const priv = await handleProxy(route('/live/svc/x'), {
      ...deps,
      policy: { upstream: () => 'http://169.254.169.254' },
    })
    expect(priv?.status).toBe(403)
    expect(u.seen).toHaveLength(0)
  })

  it('does not forward the page identity or connection headers, and passes redirects through', async () => {
    const u = upstream(
      () =>
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
    )
    const res = await handleProxy(
      route('/live/svc/x', {
        headers: {
          cookie: 'sid=1',
          origin: 'http://localhost:5173',
          referer: 'http://localhost:5173/',
          'x-keep': 'yes',
        },
      }),
      { mount: '/__specbook/proxy', policy, lookup, fetch: u.fetch },
    )
    const h = u.seen[0]?.headers as Headers
    expect(h.get('cookie')).toBeNull()
    expect(h.get('origin')).toBeNull()
    expect(h.get('referer')).toBeNull()
    expect(h.get('x-keep')).toBe('yes')
    // a redirect is the caller's to follow, so it cannot leave the allow-listed host
    expect(u.seen[0]?.redirect).toBe('manual')
    expect(res?.status).toBe(302)
  })

  it('reports events without any content', async () => {
    const u = upstream()
    const events: unknown[] = []
    await handleProxy(route('/live/svc/x', { headers: { a: '{{secrets.KEY}}' } }), {
      mount: '/__specbook/proxy',
      policy,
      lookup,
      fetch: u.fetch,
      onEvent: (e) => events.push(e),
    })
    expect(JSON.stringify(events)).not.toContain('sk_real')
    expect(events[0]).toMatchObject({ service: 'svc', env: 'live', status: 200, outcome: 'ok' })
  })

  it('maps an upstream failure to 502 and a stalled upstream to 504', async () => {
    const boom = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    const r = await handleProxy(route('/live/svc/x'), {
      mount: '/__specbook/proxy',
      policy,
      fetch: boom,
    })
    expect(r?.status).toBe(502)
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) =>
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))),
      )) as unknown as typeof fetch
    const t = await handleProxy(route('/live/svc/x'), {
      mount: '/__specbook/proxy',
      policy: { ...policy, timeoutMs: 20 },
      fetch: hang,
    })
    expect(t?.status).toBe(504)
  })
})

describe('the extension side (wire)', () => {
  const allow = (origins: string[]) => (o: string) => origins.includes(o)

  it('round-trips a binary body and substitutes only for an origin the user allowed', async () => {
    const u = upstream()
    const png = bytes(0x89, 0x50, 0xff, 0xfe, 0x00, 0x80)
    const req = new Request('https://api.example.com/v1/up?k={{secrets.KEY}}', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: png,
    })
    const wire = await requestToWire(req)
    expect(wire.body?.kind).toBe('b64')
    // survives JSON, as it does between the page and the worker
    const msg = {
      v: 1 as const,
      type: 'fetch' as const,
      id: '1',
      req: JSON.parse(JSON.stringify(wire)),
    }
    expect(hex(new Uint8Array(await wireToRequest(msg.req).arrayBuffer()))).toBe(hex(png))

    const ok = await handleWireFetch(msg, {
      allow: allow(['https://api.example.com']),
      lookup,
      fetch: u.fetch,
    })
    expect(ok).toMatchObject({ type: 'response', id: '1' })
    expect(u.seen[0]?.url).toBe('https://api.example.com/v1/up?k=sk_real')
    expect(hex(u.seen[0]?.body as Uint8Array)).toBe(hex(png))

    const no = await handleWireFetch(msg, { allow: allow([]), lookup, fetch: u.fetch })
    expect(no).toMatchObject({ type: 'error', code: 'not-allowed' })
    expect(u.seen).toHaveLength(1)
  })

  it('reaches a local address the user allowed, and names a missing secret', async () => {
    const u = upstream()
    const local = await requestToWire(new Request('http://localhost:4001/ping'))
    const r = await handleWireFetch(
      { v: 1, type: 'fetch', id: 'a', req: local },
      { allow: () => true, fetch: u.fetch },
    )
    expect(r.type).toBe('response')
    const need = await requestToWire(
      new Request('https://api.example.com/x', { headers: { authorization: '{{secrets.NOPE}}' } }),
    )
    const m = await handleWireFetch(
      { v: 1, type: 'fetch', id: 'b', req: need },
      { allow: () => true, fetch: u.fetch },
    )
    expect(m).toMatchObject({ type: 'error', code: 'missing-secrets' })
  })

  it('forward() alone applies the same policy for a caller that names the URL', async () => {
    const u = upstream()
    const res = await forward(
      new Request('https://api.example.com/x', { headers: { a: '{{secrets.KEY}}' } }),
      { url: 'https://api.example.com/x' },
      { policy: {}, lookup, fetch: u.fetch },
    )
    expect(res.status).toBe(200)
    expect(u.seen[0]?.headers.get('a')).toBe('sk_real')
  })
})
