import { describe, expect, it, vi } from 'vitest'
import { createWireHandler, type WireAuditEvent, type WireCall, type WireHost } from '../src/proxy'

type Fetch = typeof fetch
const SITE = 'https://ui.specbook.dev'
const API = 'https://api.example.com'

const fetchCall = (
  path: string,
  init: Partial<Extract<WireCall, { type: 'fetch' }>['req']> = {},
  id = 'c1',
) =>
  ({
    v: 1,
    type: 'fetch',
    id,
    req: { method: 'GET', url: `${API}${path}`, headers: {}, ...init },
  }) as Extract<WireCall, { type: 'fetch' }>

/** A host with one grant, and a fetch that records what reached the "network". */
function setup(over: Partial<WireHost> = {}) {
  const sent: { url: string; init?: RequestInit }[] = []
  const audit: WireAuditEvent[] = []
  const f = (async (url: string, init?: RequestInit) => {
    sent.push({ url, init })
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as Fetch
  const grants = new Set([`${SITE}\n${API}`])
  const host: WireHost = {
    isGranted: (site, origin) => grants.has(`${site}\n${origin}`),
    record: (e) => audit.push(e),
    fetch: f,
    ...over,
  }
  return { handler: createWireHandler(host), sent, audit, grants }
}

describe('ping, status and grant', () => {
  it('answers a ping with the protocol version', async () => {
    const { handler } = setup()
    expect(await handler.handle({ v: 1, type: 'ping' }, { site: SITE })).toMatchObject({
      type: 'pong',
      version: 1,
    })
  })

  it('reports which origins this site may reach and which it may not, without asking anyone', async () => {
    const requestGrant = vi.fn()
    const { handler } = setup({ requestGrant })
    const r = await handler.handle(
      { v: 1, type: 'status', apiOrigins: [API, 'https://other.example'] },
      { site: SITE },
    )
    expect(r).toMatchObject({ type: 'status', granted: [API], missing: ['https://other.example'] })
    expect(requestGrant).not.toHaveBeenCalled()
  })

  it('a grant call asks only about what is missing, and answers with the state at that moment', async () => {
    const requestGrant = vi.fn()
    const { handler } = setup({ requestGrant })
    const r = await handler.handle(
      { v: 1, type: 'grant', apiOrigins: [API, 'https://other.example'] },
      { site: SITE },
    )
    expect(requestGrant).toHaveBeenCalledWith(SITE, ['https://other.example'])
    expect(r).toMatchObject({ type: 'status', missing: ['https://other.example'] })
  })

  it('a grant call for changes asks only about origins that may be read but not changed', async () => {
    const requestGrant = vi.fn()
    const allowsWrites = vi.fn((_s: string, o: string) => o === 'https://changeable.example')
    const { handler, grants } = setup({ requestGrant, allowsWrites })
    grants.add(`${SITE}\nhttps://changeable.example`)
    await handler.handle(
      {
        v: 1,
        type: 'grant',
        apiOrigins: [API, 'https://changeable.example', 'https://not-allowed.example'],
        writes: true,
      },
      { site: SITE },
    )
    // not the one that can already be changed, and not the one that cannot even be read
    expect(requestGrant).toHaveBeenCalledWith(SITE, [API], { writes: true })
  })

  it('a grant call for changes does not bother the person when every origin can be changed', async () => {
    const requestGrant = vi.fn()
    const { handler } = setup({ requestGrant, allowsWrites: () => true })
    await handler.handle({ v: 1, type: 'grant', apiOrigins: [API], writes: true }, { site: SITE })
    expect(requestGrant).not.toHaveBeenCalled()
  })

  it('does not bother the person when nothing is missing', async () => {
    const requestGrant = vi.fn()
    const { handler } = setup({ requestGrant })
    await handler.handle({ v: 1, type: 'grant', apiOrigins: [API] }, { site: SITE })
    expect(requestGrant).not.toHaveBeenCalled()
  })
})

describe('a grant belongs to a pair of site and API', () => {
  it('lets the granted site through, and refuses another site for the same API', async () => {
    const { handler, sent } = setup()
    expect(await handler.handle(fetchCall('/pets'), { site: SITE })).toMatchObject({
      type: 'response',
    })
    const other = await handler.handle(fetchCall('/pets'), { site: 'https://evil.example' })
    expect(other).toMatchObject({ type: 'error', code: 'not-allowed' })
    expect(sent).toHaveLength(1)
  })

  it('refuses an API the site was never granted', async () => {
    const { handler, sent } = setup()
    const call = fetchCall('/x')
    const unknown = { ...call, req: { ...call.req, url: 'https://other.example/x' } }
    const r = await handler.handle(unknown, { site: SITE })
    expect(r).toMatchObject({ type: 'error', code: 'not-allowed' })
    expect(sent).toHaveLength(0)
  })
})

describe('read-only until the person says otherwise', () => {
  it('refuses a change, with a reason that says what to do', async () => {
    const { handler, sent } = setup()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await handler.handle(fetchCall('/pets', { method }), { site: SITE })
      expect(r).toMatchObject({ type: 'error', code: 'read-only' })
    }
    expect(sent).toHaveLength(0)
  })

  it('lets reads through, and changes once that pair was allowed them', async () => {
    const allowed = new Set([`${SITE}\n${API}`])
    const { handler, sent } = setup({ allowsWrites: (s, o) => allowed.has(`${s}\n${o}`) })
    expect(
      await handler.handle(fetchCall('/pets', { method: 'HEAD' }), { site: SITE }),
    ).toMatchObject({
      type: 'response',
    })
    expect(
      await handler.handle(fetchCall('/pets', { method: 'POST' }), { site: SITE }),
    ).toMatchObject({
      type: 'response',
    })
    expect(sent.map((s) => s.init?.method)).toEqual(['HEAD', 'POST'])
  })
})

describe('secrets, private addresses and the audit trail', () => {
  it('names a secret nobody holds', async () => {
    const { handler } = setup()
    const r = await handler.handle(
      fetchCall('/pets', { headers: { 'x-key': '{{secrets.NOPE}}' } }),
      { site: SITE },
    )
    expect(r).toMatchObject({ type: 'error', code: 'missing-secrets' })
  })

  it('refuses a private address even for a granted pair, unless the pair opted in', async () => {
    const local = 'http://localhost:4001'
    const grants = new Set([`${SITE}\n${local}`])
    const base = { isGranted: (s: string, o: string) => grants.has(`${s}\n${o}`) }
    const refused = setup(base)
    const call = { ...fetchCall('/'), req: { ...fetchCall('/').req, url: `${local}/ping` } }
    expect(await refused.handler.handle(call, { site: SITE })).toMatchObject({
      type: 'error',
      code: 'blocked',
    })
    expect(refused.sent).toHaveLength(0)

    const opted = setup({ ...base, allowsPrivate: () => true })
    expect(await opted.handler.handle(call, { site: SITE })).toMatchObject({ type: 'response' })
  })

  it('records what happened, with no query string and no body', async () => {
    const { handler, audit } = setup()
    await handler.handle(fetchCall('/pets?api_key=sk_in_the_query', { method: 'GET' }), {
      site: SITE,
    })
    await handler.handle(fetchCall('/pets', { method: 'DELETE' }), { site: SITE })
    expect(audit).toHaveLength(2)
    expect(audit[0]).toMatchObject({
      site: SITE,
      origin: API,
      method: 'GET',
      path: '/pets',
      outcome: 'ok',
      status: 200,
    })
    expect(audit[1]).toMatchObject({ method: 'DELETE', outcome: 'refused', code: 'read-only' })
    expect(JSON.stringify(audit)).not.toContain('sk_in_the_query')
  })
})

describe('the rate limit', () => {
  it('stops a loop at the limit, per pair, and lets it go again a minute on', async () => {
    let t = 1_000_000
    const { handler, sent } = setup({ perMinute: 3, now: () => t })
    for (let i = 0; i < 3; i++)
      expect(await handler.handle(fetchCall('/p', {}, `c${i}`), { site: SITE })).toMatchObject({
        type: 'response',
      })
    expect(await handler.handle(fetchCall('/p', {}, 'c4'), { site: SITE })).toMatchObject({
      type: 'error',
      code: 'rate-limited',
    })
    expect(sent).toHaveLength(3)
    t += 61_000
    expect(await handler.handle(fetchCall('/p', {}, 'c5'), { site: SITE })).toMatchObject({
      type: 'response',
    })
  })

  it('counts each pair on its own', async () => {
    const grants = new Set([`${SITE}\n${API}`, `${SITE}\nhttps://b.example`])
    const { handler } = setup({ perMinute: 1, isGranted: (s, o) => grants.has(`${s}\n${o}`) })
    expect(await handler.handle(fetchCall('/p'), { site: SITE })).toMatchObject({
      type: 'response',
    })
    const b = { ...fetchCall('/p'), req: { ...fetchCall('/p').req, url: 'https://b.example/p' } }
    expect(await handler.handle(b, { site: SITE })).toMatchObject({ type: 'response' })
  })
})

describe('abort', () => {
  it('cancels a call in flight, for the site that made it only', async () => {
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_r, rej) =>
        init?.signal?.addEventListener('abort', () =>
          rej(new DOMException('aborted', 'AbortError')),
        ),
      )) as unknown as Fetch
    const { handler } = setup({ fetch: hang })
    const pending = handler.handle(fetchCall('/slow', {}, 'long'), { site: SITE })
    // another site naming the same id changes nothing
    await handler.handle({ v: 1, type: 'abort', id: 'long' }, { site: 'https://evil.example' })
    let settled = false
    pending.then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    expect(
      await handler.handle({ v: 1, type: 'abort', id: 'long' }, { site: SITE }),
    ).toBeUndefined()
    expect(await pending).toMatchObject({ type: 'error', code: 'aborted' })
  })
})
