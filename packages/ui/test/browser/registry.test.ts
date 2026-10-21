import * as reg from 'virtual:specbook/registry'
import {
  handleWireFetch,
  installFaker,
  prepareFaker,
  type WireCall,
  type WireReply,
} from '@specbook/core'
import { faker } from '@specbook/core/faker'
import { describe, expect, it } from 'vitest'
import { createEngine } from '../../src/engine'
import type { ExtensionBridge } from '../../src/extension'
import { secretStore } from '../../src/secrets'

const engine = createEngine(reg as never)

describe('registry loads project modules in a real browser', () => {
  it('lists services, requests and sequences from the example project', () => {
    expect(Object.keys(reg.manifests)).toEqual(
      expect.arrayContaining(['petstore', 'stripe', 'github']),
    )
    expect(reg.requests.length).toBeGreaterThan(5)
    expect(reg.sequences.map((s) => s.file)).toContain('sequences/adopt-pet.seq.ts')
  })

  it('example JSON loads as an ES module with a default export', async () => {
    const mod = await reg.examples['petstore/FindPetsByStatus.200']?.(0)
    const list = mod?.default as unknown[] | undefined
    expect(Array.isArray(list)).toBe(true)
    expect(list?.length ?? 0).toBeGreaterThan(0)
  })

  it('generated operation modules load', async () => {
    const mod = await reg.operations['petstore/AddPet']?.(0)
    expect(mod?.AddPet.meta).toMatchObject({ id: 'AddPet', method: 'POST', service: 'petstore' })
  })

  it('config loads', async () => {
    const cfg = (await reg.loadConfig(0)).default
    expect(cfg.project).toBe('petstore-example')
    expect(await engine.environments(0)).toContain('mock')
  })

  it('faker resolves to an ESM build and honours locale and seed', async () => {
    expect(reg.loadFaker).not.toBeNull()
    const bundled = (await reg.loadFaker?.(0)) as Record<string, unknown>
    expect(typeof bundled.Faker).toBe('function')
    // locales are separate chunks: nothing but the ones asked for is loaded
    const config = { locales: { de: ['de', 'en'] } }
    const mod = await prepareFaker(bundled, config, 'de')
    expect(Object.keys(mod).sort()).toEqual(['Faker', 'base', 'de', 'en'])
    installFaker(mod as never, config, { locale: 'de', seed: 1 })
    const a = faker.person.firstName()
    installFaker(mod as never, config, { locale: 'de', seed: 1 })
    expect(faker.person.firstName()).toBe(a)
  })
})

describe('every example request and sequence passes against mocks', () => {
  const entries = [...reg.requests, ...reg.sequences]
  it.each(entries.map((e) => [e.file, e] as const))('%s', async (_file, entry) => {
    const mod = await entry.load(0)
    const target = mod.default
    expect(target?.kind === 'request' || target?.kind === 'sequence').toBe(true)
    const fakerMod = await prepareFaker((await reg.loadFaker?.(0)) as never)
    installFaker(fakerMod, undefined, { seed: 42 })
    const result = await engine.run(target, { env: 'mock', version: 0, onInput: () => ({}) })
    const failures = result.steps
      .filter((s) => s.status !== 'pass')
      .map(
        (s) =>
          `${s.name}: ${
            s.error ??
            s.assertions
              .filter((a) => !a.pass)
              .map((a) => a.label)
              .join(', ')
          }`,
      )
    expect(failures).toEqual([])
    expect(result.status).toBe('pass')
  })

  describe('a static build', () => {
    const origin = 'https://petstore3.swagger.io'
    const staticEngine = createEngine({ ...reg, mode: 'static' } as never)
    const call = async () => {
      const urls: string[] = []
      const headers: string[] = []
      const real = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input))
        headers.push(JSON.stringify(init?.headers ?? {}))
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch
      try {
        const def = await staticEngine.operationRequest('petstore/FindPetsByStatus', 0, {
          query: { status: 'available' },
        })
        const result = await staticEngine.run(def, { env: 'live', version: 0 })
        return { step: result.steps[0], urls, headers }
      } finally {
        globalThis.fetch = real
      }
    }

    it('lists live environments', async () => {
      expect(await staticEngine.environments(0)).toEqual(expect.arrayContaining(['mock', 'live']))
    })

    it('calls the API directly, not through the dev proxy, with the secret held for its origin', async () => {
      secretStore.set(origin, 'PETSTORE_API_KEY', 'k-123')
      try {
        const { step, urls, headers } = await call()
        expect(step?.error).toBeUndefined()
        expect(step?.response?.status).toBe(200)
        expect(urls[0]).toMatch(/^https:\/\/petstore3\.swagger\.io\/api\/v3\/pet\/findByStatus/)
        expect(urls.some((u) => u.includes('/__specbook/proxy'))).toBe(false)
        expect(headers[0]).toContain('k-123')
        // the recorded request keeps the placeholder: the value is never shown back
        expect(JSON.stringify(step?.request)).not.toContain('k-123')
      } finally {
        secretStore.remove(origin, 'PETSTORE_API_KEY')
      }
    })

    it('asks for a missing secret and never sends a key held for a different origin', async () => {
      secretStore.set('https://evil.example', 'PETSTORE_API_KEY', 'not-for-you')
      try {
        const { step, urls } = await call()
        expect(step?.error).toContain('Missing secrets: PETSTORE_API_KEY')
        expect(urls).toEqual([])
      } finally {
        secretStore.remove('https://evil.example', 'PETSTORE_API_KEY')
      }
    })
  })
})

describe('environment risk from the config', () => {
  const withEnvironments = (environments: unknown) =>
    createEngine({
      ...reg,
      loadConfig: async () => ({
        default: { ...(await reg.loadConfig(0)).default, environments },
      }),
    } as never)

  it('lists marked environments and reports only the marks that mean something', async () => {
    const e = withEnvironments({
      live: { risk: 'production' },
      qa: { risk: 'sandbox' },
      staging: { vars: { a: 1 } },
      odd: { risk: 'dangerous' },
    })
    expect(await e.environmentRisks(0)).toEqual({ live: 'production', qa: 'sandbox' })
    // an environment that only has settings still appears in the list
    expect(await e.environments(0)).toEqual(
      expect.arrayContaining(['mock', 'live', 'qa', 'staging']),
    )
  })
})

describe('who makes the call', () => {
  const origin = 'https://petstore3.swagger.io'
  const cfgWith = (baseUrl: string) => ({
    ...reg,
    loadConfig: async () => {
      const c = (await reg.loadConfig(0)).default
      return {
        default: {
          ...c,
          services: {
            ...c.services,
            petstore: { ...c.services.petstore, baseUrl: { live: baseUrl } },
          },
        },
      }
    },
  })

  const withFetch = async <T>(
    reply: (url: string, init?: RequestInit) => Response,
    run: (seen: { url: string; headers: string }[]) => Promise<T>,
  ) => {
    const seen: { url: string; headers: string }[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: JSON.stringify(init?.headers ?? {}) })
      return reply(String(input), init)
    }) as typeof fetch
    try {
      return await run(seen)
    } finally {
      globalThis.fetch = real
    }
  }
  const ok = () => new Response('[]', { headers: { 'content-type': 'application/json' } })
  const send = async (engine: ReturnType<typeof createEngine>) => {
    const def = await engine.operationRequest('petstore/FindPetsByStatus', 0, {
      query: { status: 'available' },
    })
    return (await engine.run(def, { env: 'live', version: 0 })).steps[0]
  }

  it('the dev server: a value typed in the page is sent to it, and a name without one is left for its environment', async () => {
    const engine = createEngine({ ...reg, mode: 'dev' } as never)
    secretStore.set(origin, 'PETSTORE_API_KEY', 'typed-1')
    try {
      const typed = await withFetch(ok, async (seen) => {
        await send(engine)
        return seen.find((x) => x.url.includes('/__specbook/proxy/'))
      })
      expect(typed?.url).toMatch(/^\/__specbook\/proxy\/live\/petstore\/pet\/findByStatus/)
      expect(typed?.headers).toContain('typed-1')
    } finally {
      secretStore.remove(origin, 'PETSTORE_API_KEY')
    }
    const left = await withFetch(ok, async (seen) => {
      const step = await send(engine)
      return { sent: seen.find((x) => x.url.includes('/__specbook/proxy/')), step }
    })
    // no value typed: the placeholder goes to the dev server, which fills it from its environment
    expect(left.sent?.headers).toContain('{{secrets.PETSTORE_API_KEY}}')
    expect(left.step?.error).toBeUndefined()
  })

  it('a cross-origin API goes through the extension when it is there, with the typed value applied', async () => {
    const calls: { url: string; header: string }[] = []
    const bridge: ExtensionBridge = {
      version: 1,
      send: async (call: WireCall): Promise<WireReply> => {
        if (call.type !== 'fetch') return { v: 1, type: 'pong', version: 1 }
        return handleWireFetch(call, {
          allow: (o) => o === origin,
          fetch: (async (url: string, init?: RequestInit) => {
            calls.push({ url, header: new Headers(init?.headers).get('api_key') ?? '' })
            return ok()
          }) as unknown as typeof fetch,
        })
      },
    }
    const engine = createEngine({ ...reg, mode: 'static' } as never, {
      extension: async () => bridge,
    })
    secretStore.set(origin, 'PETSTORE_API_KEY', 'ext-key')
    try {
      const page = await withFetch(ok, async (seen) => {
        const step = await send(engine)
        expect(step?.error).toBeUndefined()
        expect(step?.response?.status).toBe(200)
        return seen
      })
      // the page never called the API itself; the extension did, with the value
      expect(page).toHaveLength(0)
      expect(calls[0]?.url).toContain('petstore3.swagger.io/api/v3/pet/findByStatus')
      expect(calls[0]?.header).toBe('ext-key')
    } finally {
      secretStore.remove(origin, 'PETSTORE_API_KEY')
    }
  })

  it('a same-origin API is called by the page even when the extension is there', async () => {
    let asked = false
    const bridge: ExtensionBridge = {
      version: 1,
      send: async () => {
        asked = true
        return { v: 1, type: 'pong', version: 1 }
      },
    }
    // static: no dev proxy, so the choice is between the page and the extension
    const engine = createEngine({ ...cfgWith('/api/v3'), mode: 'static' } as never, {
      extension: async () => bridge,
    })
    secretStore.set(location.origin, 'PETSTORE_API_KEY', 'same')
    try {
      const seen = await withFetch(ok, async (s) => {
        await send(engine)
        return s
      })
      expect(seen[0]?.url).toBe(`${location.origin}/api/v3/pet/findByStatus?status=available`)
      expect(seen[0]?.headers).toContain('same')
      expect(asked).toBe(false)
    } finally {
      secretStore.remove(location.origin, 'PETSTORE_API_KEY')
    }
  })

  it('a blocked direct call says it may be CORS and what to do', async () => {
    const engine = createEngine({ ...reg, mode: 'static' } as never)
    secretStore.set(origin, 'PETSTORE_API_KEY', 'k')
    try {
      const step = await withFetch(
        () => {
          throw new TypeError('Failed to fetch')
        },
        () => send(engine),
      )
      expect(step?.error).toMatch(/could not reach petstore/)
      expect(step?.error).toMatch(/CORS/)
      // the way out in the message is the embed on the API's own origin; the extension is offered by the
      // response panel, from the hint, so the message does not repeat it
      expect(step?.error).toMatch(/Embed the viewer/)
      expect(step?.error).not.toMatch(/extension/i)
      expect(step?.errorHint).toEqual({ code: 'cors', origin })
      // the dev server is not offered as the fix for a hosted page
      expect(step?.error).not.toMatch(/specbook dev/i)
    } finally {
      secretStore.remove(origin, 'PETSTORE_API_KEY')
    }
  })

  it('an extension that is installed but out of date is told apart in the hint', async () => {
    const old: ExtensionBridge = {
      version: 0,
      send: async () => ({ v: 1, type: 'pong', version: 0 }),
    }
    const engine = createEngine({ ...reg, mode: 'static' } as never, { extension: async () => old })
    secretStore.set(origin, 'PETSTORE_API_KEY', 'k')
    try {
      const step = await withFetch(
        () => {
          throw new TypeError('Failed to fetch')
        },
        () => send(engine),
      )
      expect(step?.errorHint).toEqual({ code: 'outdated', origin })
    } finally {
      secretStore.remove(origin, 'PETSTORE_API_KEY')
    }
  })

  it("offers nothing when the call worked, or the API is on the page's own origin", async () => {
    secretStore.set(origin, 'PETSTORE_API_KEY', 'k')
    secretStore.set(location.origin, 'PETSTORE_API_KEY', 'k')
    try {
      // an API that allows the page answers, so there is nothing to offer
      const worked = await withFetch(ok, () =>
        send(createEngine({ ...reg, mode: 'static' } as never)),
      )
      expect(worked?.errorHint).toBeUndefined()
      // a failure on the page's own origin is not CORS
      const failed = await withFetch(
        () => {
          throw new TypeError('Failed to fetch')
        },
        () => send(createEngine({ ...cfgWith('/api/v3'), mode: 'static' } as never)),
      )
      expect(failed?.error).toBeDefined()
      expect(failed?.errorHint).toBeUndefined()
    } finally {
      secretStore.remove(origin, 'PETSTORE_API_KEY')
      secretStore.remove(location.origin, 'PETSTORE_API_KEY')
    }
  })
})
