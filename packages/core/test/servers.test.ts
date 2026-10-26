import { describe, expect, it } from 'vitest'
import { liveBaseUrl, MAX_SERVERS, openApiServers } from '../src/internal'

const SRC = 'https://docs.example.com/openapi.json'
const names = (api: object, source = SRC) =>
  openApiServers(api, source).servers.map((s) => [s.name, s.url])

describe('openApiServers', () => {
  it('makes the first server `live` and names the others from their description', () => {
    expect(
      names({
        servers: [
          { url: 'https://api.example.com/v1', description: 'Production' },
          { url: 'https://sandbox.example.com/v1', description: 'Sandbox (test data)' },
          { url: 'https://eu.example.com/v1', description: 'EU region' },
        ],
      }),
    ).toEqual([
      ['live', 'https://api.example.com/v1'],
      ['sandbox-test-data', 'https://sandbox.example.com/v1'],
      ['eu-region', 'https://eu.example.com/v1'],
    ])
  })

  it('keeps the description for a tooltip', () => {
    const r = openApiServers(
      {
        servers: [
          { url: 'https://a.test', description: ' Production ' },
          { url: 'https://b.test' },
        ],
      },
      SRC,
    )
    expect(r.servers[0]?.description).toBe('Production')
    expect(r.servers[1]?.description).toBeUndefined()
  })

  it('names a server with no description from its host', () => {
    expect(
      names({ servers: [{ url: 'https://a.test' }, { url: 'https://sandbox.api.test:8443/x' }] }),
    ).toEqual([
      ['live', 'https://a.test'],
      ['sandbox-api-test-8443', 'https://sandbox.api.test:8443/x'],
    ])
  })

  it('never reuses a name, never uses `mock` or `live`, and drops a repeated address', () => {
    const r = openApiServers(
      {
        servers: [
          { url: 'https://a.test' },
          { url: 'https://b.test', description: 'Live' },
          { url: 'https://c.test', description: 'Mock' },
          { url: 'https://d.test', description: 'Sandbox' },
          { url: 'https://e.test', description: 'sandbox' },
          { url: 'https://a.test/', description: 'Again' },
        ],
      },
      SRC,
    )
    expect(r.servers.map((s) => s.name)).toEqual([
      'live',
      'live-2',
      'mock-2',
      'sandbox',
      'sandbox-2',
    ])
  })

  it('produces names the dev server and proxy accept', () => {
    const r = openApiServers(
      {
        servers: [
          { url: 'https://a.test' },
          {
            url: 'https://b.test',
            description: 'Ünïcode / slashes & very long description that goes on and on',
          },
        ],
      },
      SRC,
    )
    for (const s of r.servers) expect(s.name).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(r.servers[1]?.name.length).toBeLessThanOrEqual(24)
  })

  it('fills variables with their defaults and drops a server that still has a hole', () => {
    expect(
      names({
        servers: [
          {
            url: 'https://{region}.api.example.com/{version}',
            description: 'Regional',
            variables: { region: { default: 'us' }, version: { default: 'v2' } },
          },
          { url: 'https://{tenant}.example.com', description: 'Per tenant' },
        ],
      }),
    ).toEqual([['live', 'https://us.api.example.com/v2']])
  })

  it('resolves a relative server against a URL source', () => {
    expect(
      names({ servers: [{ url: '/api/v3' }, { url: '../sandbox', description: 'Sandbox' }] }),
    ).toEqual([
      ['live', 'https://docs.example.com/api/v3'],
      ['sandbox', 'https://docs.example.com/sandbox'],
    ])
  })

  it('asks for a base URL when the first server is relative and there is no URL to resolve it', () => {
    const r = openApiServers(
      { servers: [{ url: '/api/v3' }, { url: 'https://sandbox.test', description: 'Sandbox' }] },
      'pasted document',
    )
    expect(r.needsBaseUrl).toBe(true)
    // there is no `live` until the person gives one; the absolute server is still offered
    expect(r.servers.map((s) => s.name)).toEqual(['sandbox'])
    expect(liveBaseUrl({ servers: [{ url: '/api/v3' }] }, 'pasted document')).toBeUndefined()
  })

  it('does not ask for one when the first server is simply unusable', () => {
    expect(openApiServers({ servers: [{ url: 'https://{x}.test' }] }, SRC).needsBaseUrl).toBe(false)
  })

  it('caps the list and says how many were left out', () => {
    const servers = Array.from({ length: 30 }, (_, i) => ({
      url: `https://s${i}.test`,
      description: `Region ${i}`,
    }))
    const r = openApiServers({ servers }, SRC)
    expect(r.servers).toHaveLength(MAX_SERVERS)
    expect(r.omitted).toBe(30 - MAX_SERVERS)
    expect(r.servers[0]?.name).toBe('live')
  })

  it('falls back to a Swagger 2 host, then to where the document came from', () => {
    expect(names({ host: 'api.example.com', basePath: '/v2', schemes: ['https', 'http'] })).toEqual(
      [['live', 'https://api.example.com/v2']],
    )
    expect(names({ paths: {} })).toEqual([['live', 'https://docs.example.com']])
    expect(names({ paths: {} }, 'pasted')).toEqual([])
  })

  it('keeps liveBaseUrl as the `live` address', () => {
    expect(
      liveBaseUrl(
        { servers: [{ url: 'https://api.example.com/' }, { url: 'https://b.test' }] },
        SRC,
      ),
    ).toBe('https://api.example.com')
  })
})
