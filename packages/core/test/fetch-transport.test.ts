import { describe, expect, it } from 'vitest'
import { createFetchTransport, type PreparedRequest } from '../src/internal'

const req = (extra: Partial<PreparedRequest> = {}): PreparedRequest => ({
  opId: 'Slow',
  encoding: 'json',
  service: 'api',
  method: 'GET',
  url: '/slow',
  query: {},
  headers: {},
  ...extra,
})

/** A fetch that never answers on its own and honors the abort signal, as a real one does. */
const hanging = ((_url: string, init?: RequestInit) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('This operation was aborted', 'AbortError')),
    )
  })) as unknown as typeof fetch

describe('the fetch transport', () => {
  it('says a request timed out when its own timeout ended it', async () => {
    const send = createFetchTransport({ baseUrl: () => 'http://x.test', fetch: hanging })
    await expect(send(req({ timeoutMs: 30 }))).rejects.toThrow(/Timed out after 30ms/)
  })

  it('sends nothing for a run that was stopped before the request left', async () => {
    let calls = 0
    const send = createFetchTransport({
      baseUrl: () => 'http://x.test',
      fetch: (() => {
        calls++
        return new Promise(() => {})
      }) as unknown as typeof fetch,
    })
    const stop = new AbortController()
    stop.abort()
    await expect(send(req({ timeoutMs: 5000 }), stop.signal)).rejects.toThrow(
      /Stopped before the API answered/,
    )
    expect(calls).toBe(0)
  })

  it('leaves another reason to stop as it was: a run that is cancelled is not a timeout', async () => {
    const send = createFetchTransport({ baseUrl: () => 'http://x.test', fetch: hanging })
    const stop = new AbortController()
    const pending = send(req({ timeoutMs: 5000 }), stop.signal)
    stop.abort()
    await expect(pending).rejects.toThrow(/Stopped before the API answered/)
    await expect(pending).rejects.not.toThrow(/Timed out/)
  })
})

describe('when the API cannot be reached', () => {
  /** What node's fetch throws: a bare TypeError, with the reason one level down. */
  const failing = (cause: object) =>
    (() => {
      throw Object.assign(new TypeError('fetch failed'), { cause })
    }) as unknown as typeof fetch
  const sendTo = (base: string, cause: object) =>
    createFetchTransport({ baseUrl: () => base, fetch: failing(cause) })(req({ url: '/pet/1' }))

  it('says which host and why, in words', async () => {
    await expect(
      sendTo(
        'http://127.0.0.1:9/api',
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      ),
    ).rejects.toThrow('Could not reach 127.0.0.1:9: connection refused.')
    await expect(
      sendTo(
        'https://nope.example',
        Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
      ),
    ).rejects.toThrow('Could not reach nope.example: host not found.')
    // node reports a name that has several addresses as one error holding the others
    await expect(
      sendTo('http://localhost:9', {
        errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }],
      }),
    ).rejects.toThrow('Could not reach localhost:9: connection refused.')
    await expect(
      sendTo('https://bad.example', Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' })),
    ).rejects.toThrow('Could not reach bad.example: certificate problem.')
  })

  it("falls back to the cause's own words, and leaves an error with nothing to add as it was", async () => {
    // a port that fetch refuses has no code, only a message
    await expect(sendTo('http://127.0.0.1:9', new Error('bad port'))).rejects.toThrow(
      'Could not reach 127.0.0.1:9: bad port.',
    )
    await expect(sendTo('http://x.test', {})).rejects.toThrow('fetch failed')
    // a browser's "Failed to fetch" has no cause to read
    const bare = (() => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(
      createFetchTransport({ baseUrl: () => 'http://x.test', fetch: bare })(req()),
    ).rejects.toThrow('Failed to fetch')
  })
})

describe('absoluteBase', () => {
  it('resolves a relative address against the page and leaves an absolute one', async () => {
    const { absoluteBase } = await import('../src/internal')
    expect(absoluteBase('/api/petstore', 'https://docs.specbook.dev/test/')).toBe(
      'https://docs.specbook.dev/api/petstore',
    )
    expect(absoluteBase('https://api.example.com/v1', 'https://docs.specbook.dev/')).toBe(
      'https://api.example.com/v1',
    )
    expect(absoluteBase('not a url')).toBe('not a url')
  })
})
