import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEnvironmentStore } from '../src/custom-environments'
import { createEngine } from '../src/engine'

const base = {
  manifests: {},
  examples: {},
  operations: {},
  requestExamples: {},
  assets: {},
  docs: [],
}

const config = {
  project: 'p',
  vars: { petUrl: 'https://pets.test/v1', issuer: 'https://id.test/realms/main' },
  environments: { staging: { vars: { petUrl: 'https://staging.pets.test/v1' } } },
  services: { pets: { spec: 'x', baseUrl: '{{petUrl}}' } },
  auth: {
    sso: {
      apply: { headers: { authorization: 'Bearer {{secrets.T}}' } },
      oauth: {
        authorizationUrl: '{{issuer}}/auth',
        tokenUrl: '{{issuer}}/token',
        clientId: 'docs',
      },
    },
  },
}

const registry = (
  mode: 'dev' | 'static',
  environmentVars: Record<string, Record<string, string>> = {},
) => ({
  ...base,
  mode,
  environmentVars,
  loadConfig: async () => ({ default: config }),
})

afterEach(() => vi.unstubAllGlobals())

describe('addresses that are variables (static page)', () => {
  it('lists live for a templated address, then environments, files and browser-made ones', async () => {
    const store = createEnvironmentStore('t-list')
    store.save('mine', { from: 'staging', vars: {} })
    const engine = createEngine(registry('static', { qa: { petUrl: 'https://qa.test' } }), {
      environmentStore: store,
    })
    expect(await engine.environments(0)).toEqual(['mock', 'live', 'staging', 'qa', 'mine'])
  })

  it('renders an address with the defaults, the environment section, its file and the browser copy', async () => {
    const store = createEnvironmentStore('t-base')
    const engine = createEngine(registry('static', { qa: { petUrl: 'https://qa.test' } }), {
      environmentStore: store,
    })
    expect(await engine.baseUrlOf('pets', 'live', 0)).toBe('https://pets.test/v1')
    expect(await engine.baseUrlOf('pets', 'staging', 0)).toBe('https://staging.pets.test/v1')
    expect(await engine.baseUrlOf('pets', 'qa', 0)).toBe('https://qa.test')
    store.save('qa', { vars: { petUrl: 'http://localhost:9000' } })
    expect(await engine.baseUrlOf('pets', 'qa', 0)).toBe('http://localhost:9000')
  })

  it('signs in at the provider an environment names', async () => {
    const engine = createEngine(
      registry('static', { staging: { issuer: 'https://id.test/realms/staging' } }),
    )
    expect(await engine.oauthOf('sso', 'live', 0)).toMatchObject({
      tokenUrl: 'https://id.test/realms/main/token',
      clientId: 'docs',
    })
    expect(await engine.oauthOf('sso', 'staging', 0)).toMatchObject({
      authorizationUrl: 'https://id.test/realms/staging/auth',
    })
  })

  it('makes an environment as a copy, edits it, and forgets it', async () => {
    const store = createEnvironmentStore('t-make')
    const engine = createEngine(registry('static'), { environmentStore: store })
    expect(engine.canCreateEnvironment()).toBe(true)
    await engine.createEnvironment('fork', 'staging', 0)
    expect(store.all().fork).toEqual({
      from: 'staging',
      vars: { petUrl: 'https://staging.pets.test/v1' },
    })
    await expect(engine.createEnvironment('fork', 'live', 0)).rejects.toThrow(/already exists/)
    await expect(engine.createEnvironment('mock', 'live', 0)).rejects.toThrow(/already exists/)
    await expect(engine.createEnvironment('a b', 'live', 0)).rejects.toThrow(/letters, digits/)

    await engine.setVariable('fork', 'petUrl', 'http://localhost:8080')
    expect(await engine.baseUrlOf('pets', 'fork', 0)).toBe('http://localhost:8080')
    const view = await engine.environmentView('fork', 0)
    expect(view.removable).toBe(true)
    expect(view.addresses).toEqual([{ service: 'pets', url: 'http://localhost:8080' }])
    expect(view.rows.find((r) => r.name === 'petUrl')).toMatchObject({
      source: 'browser',
      // removing the copy's own value falls back to the defaults, not to what it was copied from
      fallback: 'https://pets.test/v1',
    })
    expect(view.rows.find((r) => r.name === 'issuer')).toMatchObject({ source: 'default' })
    expect(view.uses.petUrl?.services).toEqual(['pets'])

    engine.deleteEnvironment('fork')
    expect(await engine.environments(0)).not.toContain('fork')
  })

  it('overrides a built-in environment in the browser, and a removed override falls back', async () => {
    const store = createEnvironmentStore('t-override')
    const engine = createEngine(registry('static'), { environmentStore: store })
    await engine.setVariable('live', 'petUrl', 'https://mine.test')
    expect(await engine.baseUrlOf('pets', 'live', 0)).toBe('https://mine.test')
    await engine.setVariable('live', 'petUrl', null)
    expect(await engine.baseUrlOf('pets', 'live', 0)).toBe('https://pets.test/v1')
    expect(store.all()).toEqual({})
  })

  it('says which variable an address is missing', async () => {
    const engine = createEngine({
      ...registry('static'),
      loadConfig: async () => ({
        default: { project: 'p', services: { pets: { spec: 'x', baseUrl: '{{nowhere}}' } } },
      }),
    })
    const view = await engine.environmentView('live', 0)
    expect(view.addresses[0]?.error).toBe('No base URL for pets in live: set nowhere')
    await expect(engine.baseUrlOf('pets', 'live', 0)).rejects.toThrow(/set nowhere/)
  })

  it('has nowhere to make an environment without a store', async () => {
    const engine = createEngine(registry('static'))
    expect(engine.canCreateEnvironment()).toBe(false)
    await expect(engine.createEnvironment('x', 'live', 0)).rejects.toThrow(/nowhere to keep/)
  })
})

describe('addresses that are variables (dev server)', () => {
  it('reads the environment’s variables from the server and creates environments through it', async () => {
    const calls: [string, RequestInit | undefined][] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init])
        return new Response(
          JSON.stringify(
            url.startsWith('/__specbook/environment?env=')
              ? { vars: { petUrl: 'https://dev.test' } }
              : { ok: true },
          ),
          { status: 200 },
        )
      }),
    )
    const engine = createEngine(registry('dev'))
    expect(await engine.baseUrlOf('pets', 'staging', 0)).toBe('https://dev.test')
    await engine.createEnvironment('fork', 'staging', 0)
    expect(calls.at(-1)?.[0]).toBe('/__specbook/environment')
    expect(JSON.parse(String(calls.at(-1)?.[1]?.body))).toEqual({ name: 'fork', from: 'staging' })
    // known at once, before the registry reloads with its file
    expect(await engine.environments(0)).toContain('fork')
    await engine.setVariable('fork', 'petUrl', 'https://fork.test')
    expect(calls.at(-1)?.[0]).toBe('/__specbook/var')
  })
})
