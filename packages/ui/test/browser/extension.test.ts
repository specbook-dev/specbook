import { handleWireFetch, type WireCall } from '@specbook/core'
import { afterEach, describe, expect, it } from 'vitest'
import { detectExtension, extensionTransport } from '../../src/extension'

/** What the extension's content script does: relay page calls to its worker and post the reply back. */
function installContentScript(allow: string[], seen: string[]) {
  const on = async (e: MessageEvent) => {
    const m = e.data as { channel?: string; call?: WireCall } | undefined
    if (e.source !== window || m?.channel !== 'specbook:call' || !m.call) return
    const call = m.call
    if (call.type === 'ping') {
      window.postMessage(
        { channel: 'specbook:reply', reply: { v: 1, type: 'pong', version: 1 } },
        '*',
      )
    } else if (call.type === 'fetch') {
      const reply = await handleWireFetch(call, {
        allow: (o) => allow.includes(o),
        lookup: (n) => (n === 'TOKEN' ? 'from-extension' : undefined),
        fetch: (async (url: string, init?: RequestInit) => {
          seen.push(`${url} ${new Headers(init?.headers).get('authorization') ?? ''}`)
          return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
        }) as unknown as typeof fetch,
      })
      window.postMessage({ channel: 'specbook:reply', reply }, '*')
    }
  }
  window.addEventListener('message', on)
  return () => window.removeEventListener('message', on)
}

describe('the page side of the extension', () => {
  let stop: (() => void) | undefined
  afterEach(() => {
    stop?.()
    stop = undefined
    globalThis.__SPECBOOK_EXTENSION__ = undefined
  })

  it('finds nothing when no extension answers, quickly', async () => {
    const t = Date.now()
    expect(await detectExtension(80)).toBeUndefined()
    expect(Date.now() - t).toBeLessThan(500)
  })

  it('detects an extension, and carries a request and its reply over the window channel', async () => {
    const seen: string[] = []
    stop = installContentScript(['https://api.example.com'], seen)
    const bridge = await detectExtension(500)
    expect(bridge?.version).toBe(1)
    const send = extensionTransport(
      bridge as NonNullable<typeof bridge>,
      () => 'https://api.example.com/v1',
    )
    const res = await send({
      service: 's',
      opId: 'Op',
      method: 'POST',
      url: '/things',
      query: { a: '1' },
      headers: { authorization: '{{secrets.TOKEN}}' },
      body: { x: 1 },
      encoding: 'json',
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    // the extension, not the page, held the value
    expect(seen[0]).toBe('https://api.example.com/v1/things?a=1 from-extension')
  })

  it('reports an origin the user has not allowed as an error, not a silent failure', async () => {
    stop = installContentScript([], [])
    const bridge = await detectExtension(500)
    const send = extensionTransport(
      bridge as NonNullable<typeof bridge>,
      () => 'https://api.example.com',
    )
    await expect(
      send({
        service: 's',
        opId: 'Op',
        method: 'GET',
        url: '/x',
        query: {},
        headers: {},
        encoding: 'none',
      }),
    ).rejects.toThrow(/not been allowed/)
  })
})
