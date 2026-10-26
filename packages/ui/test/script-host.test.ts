import { WIRE_VERSION, type WireCall, type WireReply } from '@specbook/core'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ExtensionBridge } from '../src/extension'
import { browserScriptHost, resetLoadedScripts } from '../src/script-host'

const PAGE = 'https://portal.example'

/** An extension that answers every fetch from `reply`, and records what it was asked. */
function bridge(reply: (call: Extract<WireCall, { type: 'fetch' }>) => WireReply) {
  const calls: Extract<WireCall, { type: 'fetch' }>[] = []
  const b: ExtensionBridge = {
    version: WIRE_VERSION,
    send: async (call) => {
      if (call.type !== 'fetch') throw new Error(`unexpected ${call.type}`)
      calls.push(call)
      return reply(call)
    },
  }
  return { bridge: b, calls }
}

const ok = (id: string, text = 'from the extension'): WireReply => ({
  v: 1,
  type: 'response',
  id,
  res: { status: 200, headers: { 'content-type': 'text/plain' }, body: { kind: 'text', text } },
})
const refused = (id: string, code: 'not-allowed' | 'read-only' = 'not-allowed'): WireReply => ({
  v: 1,
  type: 'error',
  id,
  code,
  message: 'not allowed',
})

/** The page's own fetch: records its calls and answers, or fails the way a browser does for a blocked call. */
function page(answer: (url: string) => Response | Error = () => new Response('from the page')) {
  const urls: string[] = []
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    urls.push(url)
    const r = answer(url)
    if (r instanceof Error) throw r
    return r
  }
  return { fetch, urls }
}

describe('a script’s fetch in a page', () => {
  it('calls the page’s own origin straight, with no extension', async () => {
    const { bridge: b, calls } = bridge((c) => ok(c.id))
    const own = page()
    const host = browserScriptHost({
      bridge: b,
      level: 'ready',
      pageOrigin: PAGE,
      fetch: own.fetch,
    })
    const res = await host.fetch(`${PAGE}/api/x`)
    expect(await res.text()).toBe('from the page')
    expect(calls).toHaveLength(0)
    // a relative address is the page's own too
    await host.fetch('/api/y')
    expect(own.urls).toEqual([`${PAGE}/api/x`, '/api/y'])
  })

  it('sends another origin through the extension, whole response included', async () => {
    const { bridge: b, calls } = bridge((c) => ok(c.id, '{"nonce":"n1"}'))
    const own = page()
    const host = browserScriptHost({
      bridge: b,
      level: 'ready',
      pageOrigin: PAGE,
      fetch: own.fetch,
    })
    const res = await host.fetch('https://api.vendor.example/token?x=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    })
    expect(await res.json()).toEqual({ nonce: 'n1' })
    expect(calls[0]?.req).toMatchObject({
      method: 'POST',
      url: 'https://api.vendor.example/token?x=1',
      body: { kind: 'text', text: '{"a":1}' },
    })
    expect(own.urls).toEqual([])
  })

  it('is not sent through an extension that is out of date', async () => {
    const { bridge: b, calls } = bridge((c) => ok(c.id))
    const own = page()
    const host = browserScriptHost({
      bridge: b,
      level: 'outdated',
      pageOrigin: PAGE,
      fetch: own.fetch,
    })
    expect(await (await host.fetch('https://api.vendor.example/x')).text()).toBe('from the page')
    expect(calls).toHaveLength(0)
  })

  describe('an origin the person has not allowed yet', () => {
    it('is tried from the page first when it is a read; the call that works just works', async () => {
      const { bridge: b } = bridge((c) => refused(c.id))
      const own = page()
      const host = browserScriptHost({
        bridge: b,
        level: 'ready',
        pageOrigin: PAGE,
        fetch: own.fetch,
      })
      const res = await host.fetch('https://api.vendor.example/keys')
      expect(await res.text()).toBe('from the page')
    })

    it('offers the extension’s own refusal when the browser blocks that too', async () => {
      const { bridge: b } = bridge((c) => refused(c.id))
      const own = page(() => new TypeError('Failed to fetch'))
      const host = browserScriptHost({
        bridge: b,
        level: 'ready',
        pageOrigin: PAGE,
        fetch: own.fetch,
      })
      const err = await host.fetch('https://api.vendor.example/keys').catch((e) => e)
      expect(err.name).toBe('WireError')
      expect(err.hint).toEqual({ code: 'not-allowed', origin: 'https://api.vendor.example' })
    })

    it('does not send a change from the page that the browser would send without asking the API', async () => {
      const { bridge: b } = bridge((c) => refused(c.id))
      const own = page()
      const host = browserScriptHost({
        bridge: b,
        level: 'ready',
        pageOrigin: PAGE,
        fetch: own.fetch,
      })
      // a plain POST with a text body goes out unasked: the API would act on it though the page never sees the answer
      const err = await host
        .fetch('https://api.vendor.example/charge', { method: 'POST', body: 'x' })
        .catch((e) => e)
      expect(err.hint).toEqual({ code: 'not-allowed', origin: 'https://api.vendor.example' })
      expect(own.urls).toEqual([])
    })

    it('says a change is not allowed yet when the extension allows reads only', async () => {
      const { bridge: b } = bridge((c) => refused(c.id, 'read-only'))
      const host = browserScriptHost({
        bridge: b,
        level: 'ready',
        pageOrigin: PAGE,
        fetch: page().fetch,
      })
      const err = await host
        .fetch('https://api.vendor.example/charge', { method: 'POST', body: 'x' })
        .catch((e) => e)
      expect(err.hint).toEqual({ code: 'read-only', origin: 'https://api.vendor.example' })
    })
  })

  describe('without the extension', () => {
    it('turns a blocked call into an error that carries the offer to install it', async () => {
      const own = page(() => new TypeError('Failed to fetch'))
      const host = browserScriptHost({ pageOrigin: PAGE, fetch: own.fetch })
      const err = await host.fetch('https://api.vendor.example/token').catch((e) => e)
      expect(err.message).toContain('could not reach https://api.vendor.example')
      expect(err.message).toContain('CORS')
      expect(err.hint).toEqual({ code: 'cors', origin: 'https://api.vendor.example' })
    })

    it('says the extension is out of date when it is', async () => {
      const own = page(() => new TypeError('Failed to fetch'))
      const { bridge: b } = bridge((c) => ok(c.id))
      const host = browserScriptHost({
        bridge: b,
        level: 'outdated',
        pageOrigin: PAGE,
        fetch: own.fetch,
      })
      const err = await host.fetch('https://api.vendor.example/token').catch((e) => e)
      expect(err.hint).toEqual({ code: 'outdated', origin: 'https://api.vendor.example' })
    })

    it('leaves an error that is no network failure as it is', async () => {
      const own = page(() => new RangeError('odd'))
      const host = browserScriptHost({ pageOrigin: PAGE, fetch: own.fetch })
      await expect(host.fetch('https://api.vendor.example/x')).rejects.toBeInstanceOf(RangeError)
    })
  })

  it('has the runtime of a page, and the container the panel makes', async () => {
    const el = { tag: 'div' } as unknown as HTMLElement
    const host = browserScriptHost({ pageOrigin: PAGE, mount: async () => el })
    expect(host.runtime).toBe('browser')
    expect(await host.mount?.('Approve')).toBe(el)
  })
})

describe('loading a script file', () => {
  type Tag = {
    src?: string
    async?: boolean
    integrity?: string
    crossOrigin?: string
    onload?: () => void
    onerror?: () => void
    remove?: () => void
  }
  /** A page that "loads" each file the way `settle` says: the tag's own events fire once it is in the head. */
  function fakePage(settle: (src: string) => 'load' | 'error') {
    const tags: Tag[] = []
    const removed: Tag[] = []
    const document = {
      createElement: () => {
        const tag: Tag = {}
        tag.remove = () => removed.push(tag)
        return tag
      },
      head: {
        append(tag: Tag) {
          tags.push(tag)
          queueMicrotask(() =>
            settle(tag.src ?? '') === 'load' ? tag.onload?.() : tag.onerror?.(),
          )
        },
      },
    } as unknown as Document
    return { tags, removed, document }
  }
  const globals = globalThis as Record<string, unknown>
  beforeEach(() => {
    resetLoadedScripts()
    delete globals.sdk
  })

  it('puts a script tag in the page’s head and gives back the global the file defines', async () => {
    const p = fakePage(() => {
      globals.sdk = { version: 3 }
      return 'load'
    })
    const host = browserScriptHost({ document: p.document })
    expect(await host.loadScript?.('https://cdn.example/sdk.js', { global: 'sdk' })).toEqual({
      version: 3,
    })
    expect(p.tags).toHaveLength(1)
    expect(p.tags[0]).toMatchObject({ src: 'https://cdn.example/sdk.js', async: true })
  })

  it('loads a file once, however many runs ask for it', async () => {
    const p = fakePage(() => 'load')
    const host = browserScriptHost({ document: p.document })
    await Promise.all([
      host.loadScript?.('https://cdn.example/a.js'),
      host.loadScript?.('https://cdn.example/a.js'),
    ])
    await browserScriptHost({ document: p.document }).loadScript?.('https://cdn.example/a.js')
    expect(p.tags).toHaveLength(1)
  })

  it('loads a file again when a call says once: false, and keeps one such tag in the page', async () => {
    const p = fakePage(() => 'load')
    const host = browserScriptHost({ document: p.document })
    await host.loadScript?.('https://cdn.example/e.js', { once: false })
    await host.loadScript?.('https://cdn.example/e.js', { once: false })
    expect(p.tags).toHaveLength(2)
    // the first of the two was taken down when the second came
    expect(p.removed).toEqual([p.tags[0]])
    // a call that does not say so still loads it once more, and then once only
    await host.loadScript?.('https://cdn.example/e.js')
    await host.loadScript?.('https://cdn.example/e.js')
    expect(p.tags).toHaveLength(3)
  })

  it('checks the file against an integrity hash when given one', async () => {
    const p = fakePage(() => 'load')
    await browserScriptHost({ document: p.document }).loadScript?.('https://cdn.example/b.js', {
      integrity: 'sha384-abc',
    })
    expect(p.tags[0]).toMatchObject({ integrity: 'sha384-abc', crossOrigin: 'anonymous' })
  })

  it('says what may be wrong when a file does not load, and tries again next time', async () => {
    let result: 'load' | 'error' = 'error'
    const p = fakePage(() => result)
    const host = browserScriptHost({ document: p.document })
    const err = (await host.loadScript?.('https://cdn.example/c.js').catch((e) => e)) as Error
    expect(err.message).toContain('Could not load https://cdn.example/c.js')
    expect(err.message).toContain('Content-Security-Policy')
    result = 'load'
    await host.loadScript?.('https://cdn.example/c.js')
    expect(p.tags).toHaveLength(2)
  })

  it('names the global that a loaded file did not define', async () => {
    const host = browserScriptHost({ document: fakePage(() => 'load').document })
    const err = (await host
      .loadScript?.('https://cdn.example/d.js', { global: 'sdk' })
      .catch((e) => e)) as Error
    expect(err.message).toContain('did not define `sdk`')
  })
})
