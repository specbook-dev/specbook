import { describe, expect, it } from 'vitest'
import { createFetchTransport, type PreparedRequest } from '../src'

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

  it('leaves another reason to stop as it was: a run that is cancelled is not a timeout', async () => {
    const send = createFetchTransport({ baseUrl: () => 'http://x.test', fetch: hanging })
    const stop = new AbortController()
    const pending = send(req({ timeoutMs: 5000 }), stop.signal)
    stop.abort()
    await expect(pending).rejects.toThrow(/aborted/)
    await expect(pending).rejects.not.toThrow(/Timed out/)
  })
})

describe('absoluteBase', () => {
  it('resolves a relative address against the page and leaves an absolute one', async () => {
    const { absoluteBase } = await import('../src')
    expect(absoluteBase('/api/petstore', 'https://docs.specbook.dev/test/')).toBe(
      'https://docs.specbook.dev/api/petstore',
    )
    expect(absoluteBase('https://api.example.com/v1', 'https://docs.specbook.dev/')).toBe(
      'https://api.example.com/v1',
    )
    expect(absoluteBase('not a url')).toBe('not a url')
  })
})
