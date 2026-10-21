import {
  createWireHandler,
  MissingSecretsError,
  parseWireCall,
  type WireHost,
} from '@specbook/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  detectExtension,
  extensionLevel,
  extensionTransport,
  WireError,
  wireGrant,
  wireStatus,
} from '../../src/extension'

const API = 'https://api.example.com'

/**
 * What the extension's content script does, with the real dispatcher behind it: relay a page's messages
 * (validated) to the handler, with this page's own origin as the site, and post the reply back.
 */
function installExtension(host: Partial<WireHost>, opts: { pongVersion?: number } = {}) {
  const handler = createWireHandler({ isGranted: () => false, ...host })
  const on = async (e: MessageEvent) => {
    const m = e.data as { channel?: string; call?: unknown } | undefined
    if (e.source !== window || m?.channel !== 'specbook:call') return
    const call = parseWireCall(m.call)
    if (!call) return
    if (call.type === 'ping' && opts.pongVersion !== undefined) {
      window.postMessage(
        { channel: 'specbook:reply', reply: { v: 1, type: 'pong', version: opts.pongVersion } },
        '*',
      )
      return
    }
    const reply = await handler.handle(call, { site: location.origin })
    if (reply) window.postMessage({ channel: 'specbook:reply', reply }, '*')
  }
  window.addEventListener('message', on)
  return () => window.removeEventListener('message', on)
}

const okFetch = (seen: string[]) =>
  (async (url: string, init?: RequestInit) => {
    seen.push(
      `${init?.method} ${url} ${new Headers(init?.headers).get('authorization') ?? ''}`.trim(),
    )
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

const call = (over: Record<string, unknown> = {}) => ({
  service: 's',
  opId: 'Op',
  method: 'GET' as const,
  url: '/x',
  query: {},
  headers: {},
  encoding: 'none' as const,
  ...over,
})

describe('the page side of the extension', () => {
  let stop: (() => void) | undefined
  afterEach(() => {
    stop?.()
    stop = undefined
    globalThis.__SPECBOOK_EXTENSION__ = undefined
    vi.restoreAllMocks()
  })

  it('finds nothing when no extension answers, quickly, and leaves no listener behind', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const t = Date.now()
    expect(await detectExtension(80)).toBeUndefined()
    expect(Date.now() - t).toBeLessThan(500)
    const added = add.mock.calls.filter(([type]) => type === 'message').length
    const removed = remove.mock.calls.filter(([type]) => type === 'message').length
    expect(removed).toBe(added)
  })

  it('detects an extension, and carries a request and its reply over the window channel', async () => {
    const seen: string[] = []
    stop = installExtension({
      isGranted: (_s, o) => o === API,
      allowsWrites: () => true,
      fetch: okFetch(seen),
    })
    const bridge = await detectExtension(500)
    expect(bridge?.version).toBe(1)
    expect(extensionLevel(bridge as NonNullable<typeof bridge>)).toBe('ready')
    const send = extensionTransport(bridge as NonNullable<typeof bridge>, () => `${API}/v1`)
    const res = await send(
      call({
        method: 'POST',
        url: '/things',
        query: { a: '1' },
        headers: { authorization: 'from-page' },
        body: { x: 1 },
        encoding: 'json',
      }),
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    // the page supplied the value: the extension holds no keys of its own
    expect(seen[0]).toBe(`POST ${API}/v1/things?a=1 from-page`)
  })

  it('calls an extension older than this protocol outdated, rather than sending it calls it may mishandle', async () => {
    stop = installExtension({}, { pongVersion: 0 })
    const bridge = await detectExtension(500)
    expect(bridge?.version).toBe(0)
    expect(extensionLevel(bridge as NonNullable<typeof bridge>)).toBe('outdated')
  })

  it('treats a newer extension as fine: the protocol only adds fields', async () => {
    stop = installExtension({}, { pongVersion: 7 })
    const bridge = await detectExtension(500)
    expect(extensionLevel(bridge as NonNullable<typeof bridge>)).toBe('ready')
  })
})

describe('what the person can fix is an error with a code', () => {
  let stop: (() => void) | undefined
  afterEach(() => {
    stop?.()
    stop = undefined
  })

  const open = async (host: Partial<WireHost>) => {
    stop = installExtension(host)
    const bridge = await detectExtension(500)
    return bridge as NonNullable<typeof bridge>
  }

  it('an origin that was not allowed, reported with its code and origin, and a hint for the page', async () => {
    const bridge = await open({})
    const send = extensionTransport(bridge, () => API)
    const err = await send(call()).catch((e) => e)
    expect(err).toBeInstanceOf(WireError)
    expect(err).toMatchObject({ code: 'not-allowed', origin: API })
    expect(err.hint).toEqual({ code: 'not-allowed', origin: API })
  })

  it('a change to an API the page may only read, reported as read-only', async () => {
    const bridge = await open({ isGranted: () => true })
    const send = extensionTransport(bridge, () => API)
    const err = await send(call({ method: 'DELETE' })).catch((e) => e)
    expect(err).toMatchObject({ code: 'read-only', origin: API })
    expect(err.hint).toEqual({ code: 'read-only', origin: API })
  })

  it('a failure the person cannot fix from the page carries no hint', async () => {
    const bridge = await open({
      isGranted: () => true,
      fetch: (() => Promise.reject(new TypeError('down'))) as never,
    })
    const send = extensionTransport(bridge, () => API)
    const err = await send(call()).catch((e) => e)
    expect(err).toBeInstanceOf(WireError)
    expect(err.hint).toBeUndefined()
  })

  it('a missing secret, as the same error a direct call gives, naming it', async () => {
    const bridge = await open({ isGranted: () => true })
    const send = extensionTransport(bridge, () => API)
    const err = await send(call({ headers: { 'x-key': '{{secrets.NOPE}}' } })).catch((e) => e)
    expect(err).toBeInstanceOf(MissingSecretsError)
    expect(err.names).toEqual(['NOPE'])
  })

  it('an API’s own error answer is an answer, not an error', async () => {
    const bridge = await open({
      isGranted: () => true,
      fetch: (async () =>
        new Response('{"message":"nope"}', { status: 403 })) as unknown as typeof fetch,
    })
    const res = await extensionTransport(bridge, () => API)(call())
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ message: 'nope' })
  })

  it('status says which origins are allowed without asking, and grant asks only about the rest', async () => {
    const requestGrant = vi.fn()
    const bridge = await open({ isGranted: (_s, o) => o === API, requestGrant })
    const both = [API, 'https://other.example']
    expect(await wireStatus(bridge, both)).toEqual({
      granted: [API],
      missing: ['https://other.example'],
    })
    expect(requestGrant).not.toHaveBeenCalled()
    expect(await wireGrant(bridge, both)).toEqual({
      granted: [API],
      missing: ['https://other.example'],
    })
    expect(requestGrant).toHaveBeenCalledWith(location.origin, ['https://other.example'])
  })
})
