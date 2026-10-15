import { describe, expect, it, vi } from 'vitest'
import { createDiscovery } from '../src/discovery'

const URL_ = 'https://accounts.example.com/.well-known/openid-configuration'
const doc = {
  authorization_endpoint: 'https://accounts.example.com/authorize',
  token_endpoint: 'https://oauth2.example.com/token',
}
const ok = () => new Response(JSON.stringify(doc), { status: 200 })

describe('OpenID Connect discovery on the dev server', () => {
  it('gives the origin of the token endpoint, which may be another host, and asks once', async () => {
    const f = vi.fn(async () => ok())
    const origin = createDiscovery({ fetch: f as unknown as typeof fetch })
    expect(await origin(URL_)).toBe('https://oauth2.example.com')
    expect(await origin(URL_)).toBe('https://oauth2.example.com')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('shares one request between callers that ask at the same time', async () => {
    const f = vi.fn(async () => ok())
    const origin = createDiscovery({ fetch: f as unknown as typeof fetch })
    const all = await Promise.all([origin(URL_), origin(URL_), origin(URL_)])
    expect(all).toEqual(Array(3).fill('https://oauth2.example.com'))
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('warns once and leaves the provider out when discovery fails, then tries again later', async () => {
    let t = 1_000
    const warn = vi.fn()
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockImplementation(async () => ok())
    const origin = createDiscovery({
      fetch: f as unknown as typeof fetch,
      now: () => t,
      retryAfterMs: 30_000,
      warn,
    })
    expect(await origin(URL_)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('503')
    // inside the quiet period the provider is not asked again
    t += 10_000
    expect(await origin(URL_)).toBeUndefined()
    expect(f).toHaveBeenCalledTimes(1)
    // after it, it is
    t += 30_000
    expect(await origin(URL_)).toBe('https://oauth2.example.com')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('treats a document without endpoints as a failure', async () => {
    const warn = vi.fn()
    const origin = createDiscovery({
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      warn,
    })
    expect(await origin(URL_)).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})
