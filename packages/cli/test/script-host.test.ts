import { createHash } from 'node:crypto'
import { runSequence, script, sequence } from '@specbook/core/internal'
import { describe, expect, it } from 'vitest'
import { checkIntegrity, nodeScriptHost } from '../src/script-host'

/** A "server" of script files, answering by address and counting what it was asked for. */
function files(served: Record<string, string | number>) {
  const asked: string[] = []
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    asked.push(url)
    const v = served[url]
    if (typeof v === 'number') return new Response('nope', { status: v })
    return v === undefined ? new Response('', { status: 404 }) : new Response(v)
  }
  return { fetch, asked }
}
const sri = (alg: string, text: string) => `${alg}-${createHash(alg).update(text).digest('base64')}`

describe('the node host of a script', () => {
  it('is a node host, with the fetch it was given', async () => {
    const { fetch } = files({ 'https://x.example/a': 'hi' })
    const host = nodeScriptHost({ fetch })
    expect(host.runtime).toBe('node')
    expect(await (await host.fetch('https://x.example/a')).text()).toBe('hi')
    // a place on a page is not something node has
    expect(host.mount).toBeUndefined()
  })

  it('runs a script file as a page would, and gives back the global it defines', async () => {
    const { fetch } = files({
      'https://vendor.example/pie.js':
        'var PIE = { key: "k-1", encrypt: function (s) { return s.split("").reverse().join("") } }',
    })
    const host = nodeScriptHost({ fetch })
    const pie = (await host.loadScript?.('https://vendor.example/pie.js', { global: 'PIE' })) as {
      key: string
      encrypt(s: string): string
    }
    expect(pie.key).toBe('k-1')
    expect(pie.encrypt('abc')).toBe('cba')
  })

  it('lets a second file see what the first defined, through window, self and globalThis', async () => {
    const { fetch } = files({
      'https://vendor.example/getkey.js': 'window.PIE = { key_id: "7" }',
      'https://vendor.example/encryption.js':
        'self.PIE.encrypt = function (s) { return globalThis.PIE.key_id + ":" + s.length }',
    })
    const host = nodeScriptHost({ fetch })
    await host.loadScript?.('https://vendor.example/getkey.js')
    const pie = (await host.loadScript?.('https://vendor.example/encryption.js', {
      global: 'PIE',
    })) as { encrypt(s: string): string }
    expect(pie.encrypt('four')).toBe('7:4')
  })

  it('gives the file the few things a page has that node does not name the same', async () => {
    const { fetch } = files({
      'https://vendor.example/env.js':
        'var seen = [typeof TextEncoder, typeof atob, typeof btoa, typeof crypto.subtle, typeof URL, typeof setTimeout, typeof fetch, typeof document, typeof navigator].join(",")',
    })
    const host = nodeScriptHost({ fetch })
    expect(await host.loadScript?.('https://vendor.example/env.js', { global: 'seen' })).toBe(
      'function,function,function,object,function,function,function,undefined,undefined',
    )
  })

  it('gives the file the web platform a browser library reaches for, and still no DOM', async () => {
    const names = [
      'AbortController',
      'AbortSignal',
      'Blob',
      'Event',
      'EventTarget',
      'FormData',
      'Headers',
      'Request',
      'Response',
      'performance',
      'structuredClone',
    ]
    const { fetch } = files({
      'https://vendor.example/web.js': `var seen = [${names.map((n) => `typeof ${n}`).join(', ')}, typeof document, typeof navigator].join(',')`,
    })
    const host = nodeScriptHost({ fetch })
    const seen = (await host.loadScript?.('https://vendor.example/web.js', {
      global: 'seen',
    })) as string
    expect(seen.split(',')).toEqual([
      ...names.map((n) => (n === 'performance' ? 'object' : 'function')),
      'undefined',
      'undefined',
    ])
  })

  it('makes a file that uses them work: a cancelable wait, a cloned object, a built request', async () => {
    const { fetch } = files({
      'https://vendor.example/use.js': `
        var ctl = new AbortController(); ctl.abort();
        var cloned = structuredClone({ a: [1, 2] });
        var headers = new Headers({ 'x-a': '1' });
        var req = new Request('https://x.example/', { headers: headers });
        var out = [ctl.signal.aborted, cloned.a.length, req.headers.get('x-a'), typeof performance.now()].join(',')`,
    })
    const host = nodeScriptHost({ fetch })
    expect(await host.loadScript?.('https://vendor.example/use.js', { global: 'out' })).toBe(
      'true,2,1,number',
    )
  })

  it('loads a file once, however often a script asks, and tries again after a failure', async () => {
    const served: Record<string, string | number> = { 'https://vendor.example/a.js': 'var n = 1' }
    const { fetch, asked } = files(served)
    const host = nodeScriptHost({ fetch })
    await Promise.all([
      host.loadScript?.('https://vendor.example/a.js'),
      host.loadScript?.('https://vendor.example/a.js'),
    ])
    await host.loadScript?.('https://vendor.example/a.js', { global: 'n' })
    expect(asked).toEqual(['https://vendor.example/a.js'])

    served['https://vendor.example/b.js'] = 503
    await expect(host.loadScript?.('https://vendor.example/b.js')).rejects.toThrow(
      'Could not load https://vendor.example/b.js: the server answered 503.',
    )
    served['https://vendor.example/b.js'] = 'var ok = true'
    expect(await host.loadScript?.('https://vendor.example/b.js', { global: 'ok' })).toBe(true)
  })

  it('runs a file again when a call says once: false, in the same sandbox', async () => {
    const { fetch, asked } = files({
      'https://vendor.example/count.js': 'var n = (globalThis.n || 0) + 1',
    })
    const host = nodeScriptHost({ fetch })
    expect(await host.loadScript?.('https://vendor.example/count.js', { global: 'n' })).toBe(1)
    expect(await host.loadScript?.('https://vendor.example/count.js', { global: 'n' })).toBe(1)
    expect(
      await host.loadScript?.('https://vendor.example/count.js', { global: 'n', once: false }),
    ).toBe(2)
    expect(
      await host.loadScript?.('https://vendor.example/count.js', { global: 'n', once: false }),
    ).toBe(3)
    expect(asked).toHaveLength(3)
  })

  it('names the file and the problem when it throws, and the global it did not define', async () => {
    const { fetch } = files({
      'https://vendor.example/bad.js': 'throw new Error("sdk needs a window")',
      'https://vendor.example/empty.js': 'var other = 1',
    })
    const host = nodeScriptHost({ fetch })
    await expect(host.loadScript?.('https://vendor.example/bad.js')).rejects.toThrow(
      'Could not run https://vendor.example/bad.js: sdk needs a window',
    )
    await expect(
      host.loadScript?.('https://vendor.example/empty.js', { global: 'PIE' }),
    ).rejects.toThrow('did not define `PIE`')
  })

  describe('integrity', () => {
    const url = 'https://vendor.example/sdk.js'
    const text = 'var sdk = 1'
    it('runs a file that matches any of its hashes', async () => {
      const { fetch } = files({ [url]: text })
      const host = nodeScriptHost({ fetch })
      const wrong = `sha256-${Buffer.alloc(32).toString('base64')}`
      expect(
        await host.loadScript?.(url, {
          global: 'sdk',
          integrity: `${wrong} ${sri('sha384', text)}`,
        }),
      ).toBe(1)
    })

    it('refuses a file that is not the one expected, and does not run it', async () => {
      const { fetch } = files({ [url]: text })
      const host = nodeScriptHost({ fetch })
      await expect(
        host.loadScript?.(url, { global: 'sdk', integrity: sri('sha256', 'something else') }),
      ).rejects.toThrow('does not match its integrity hash')
      // nothing was run: the global is not there for the next file
      await expect(host.loadScript?.(url, { global: 'sdk' })).resolves.toBe(1)
    })

    it('says so when no hash it can check is named', () => {
      expect(() => checkIntegrity(url, new Uint8Array(), 'md5-abc')).toThrow('names no hash')
    })
  })
})

describe('a file that needs a browser, in a run in node', () => {
  const run = async (js: string) => {
    const { fetch } = files({ 'https://vendor.example/sdk.js': js })
    const host = nodeScriptHost({ fetch })
    const widget = script({
      id: 'widget',
      name: 'Widget',
      runtime: 'isomorphic',
      run: async (_i, h) => {
        await h.loadScript('https://vendor.example/sdk.js')
        return { ok: true }
      },
    })
    const r = await runSequence(sequence({ id: 's', title: 'S' }).step('Widget', widget), {
      env: 'live',
      transport: async () => ({ status: 200, headers: {}, text: '', body: undefined }),
      scripts: host,
    })
    return r.steps[0]
  }

  it('says the script needs a browser, rather than only that document is not defined', async () => {
    const step = await run('document.body.appendChild(document.createElement("div"))')
    expect(step?.status).toBe('error')
    expect(step?.error).toContain(
      'Could not run https://vendor.example/sdk.js: document is not defined',
    )
    expect(step?.error).toContain('This script uses `document`, which a run in node does not have')
    expect(step?.error).toContain("give it runtime: 'browser'")
  })

  it('says the same for a name used inside a function the file defines and calls', async () => {
    const step = await run(
      'window.start = function () { return navigator.userAgent }; window.start()',
    )
    expect(step?.error).toContain('navigator is not defined')
    expect(step?.error).toContain('This script uses `navigator`')
  })

  it('does not blame the browser for another failure', async () => {
    const step = await run('throw new Error("sdk needs a key")')
    expect(step?.error).toBe('Could not run https://vendor.example/sdk.js: sdk needs a key')
  })
})
