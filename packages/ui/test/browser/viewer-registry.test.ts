import { afterEach, describe, expect, it } from 'vitest'
import { createEngine } from '../../src/engine'

const opened = (servers: { name: string; url: string; description?: string }[]) => ({
  service: 'shop',
  title: 'Shop',
  manifest: { operations: [] },
  metas: {},
  exampleNames: {},
  auth: {},
  secrets: {},
  authVars: {},
  authEnvironmentVars: {},
  baseUrl: servers.find((s) => s.name === 'live')?.url,
  servers,
  needsBaseUrl: false,
  warnings: [],
  timings: { parse: 0, generate: 0, total: 0 },
  bytes: { spec: 0, definitions: 0 },
})

let fresh = 0

/**
 * The registry the hosted viewer builds for a document it has just opened. The module reads its global
 * once, when first imported, so each case imports it under its own address to get a new instance.
 */
async function registryFor(open: ReturnType<typeof opened>, baseUrl?: string) {
  globalThis.__SPECBOOK_VIEWER__ = {
    open: open as never,
    bundle: async () => ({}),
    definitions: async () => ({}),
    ...(baseUrl ? { baseUrl } : {}),
  }
  return (await import(
    /* @vite-ignore */ `../../src/viewer/registry.ts?case=${++fresh}`
  )) as typeof import('../../src/viewer/registry')
}

describe('the hosted viewer’s registry offers every server as an environment', () => {
  afterEach(() => {
    globalThis.__SPECBOOK_VIEWER__ = undefined
  })

  const servers = [
    { name: 'live', url: 'https://api.example.com/v1', description: 'Production' },
    { name: 'sandbox', url: 'https://sandbox.example.com/v1', description: 'Test data' },
    { name: 'eu', url: 'https://eu.example.com/v1' },
  ]

  it('makes the first server the default address and each other server an environment of its own', async () => {
    const reg = await registryFor(opened(servers))
    const cfg = (await reg.loadConfig()).default as any
    expect(cfg.services.shop.baseUrl).toBe('{{baseUrl}}')
    expect(cfg.vars).toEqual({ baseUrl: 'https://api.example.com/v1' })
    expect(cfg.environments).toEqual({
      live: { description: 'Production' },
      sandbox: { description: 'Test data', vars: { baseUrl: 'https://sandbox.example.com/v1' } },
      eu: { vars: { baseUrl: 'https://eu.example.com/v1' } },
    })

    const engine = createEngine(reg as never)
    expect(await engine.environments(0)).toEqual(['mock', 'live', 'sandbox', 'eu'])
    expect(await engine.environmentNotes(0)).toEqual({
      live: 'Production',
      sandbox: 'Test data',
    })
    expect(await engine.baseUrlOf('shop', 'live', 0)).toBe('https://api.example.com/v1')
    expect(await engine.baseUrlOf('shop', 'eu', 0)).toBe('https://eu.example.com/v1')
  })

  it('lets the address a person typed replace `live` and nothing else', async () => {
    const reg = await registryFor(opened(servers), 'https://mine.example.com')
    const engine = createEngine(reg as never)
    expect(await engine.baseUrlOf('shop', 'live', 0)).toBe('https://mine.example.com')
    expect(await engine.baseUrlOf('shop', 'sandbox', 0)).toBe('https://sandbox.example.com/v1')
  })

  it('keeps a single-server document as it was: mock and live', async () => {
    const reg = await registryFor(opened([{ name: 'live', url: 'https://api.example.com' }]))
    const cfg = (await reg.loadConfig()).default as any
    expect(cfg.environments).toBeUndefined()
    expect(await createEngine(reg as never).environments(0)).toEqual(['mock', 'live'])
  })

  it('has no address for live until the person gives one, but still offers the other servers', async () => {
    const reg = await registryFor({
      ...opened([{ name: 'sandbox', url: 'https://sandbox.example.com' }]),
      needsBaseUrl: true,
    })
    const engine = createEngine(reg as never)
    await expect(engine.baseUrlOf('shop', 'live', 0)).rejects.toThrow(/set baseUrl/)
    expect(await engine.baseUrlOf('shop', 'sandbox', 0)).toBe('https://sandbox.example.com')
  })

  it('signs in at each server’s own provider when the document gave the address relative to it', async () => {
    const reg = await registryFor({
      ...opened(servers),
      auth: {
        sso: {
          title: 'sso',
          apply: {},
          oauth: { tokenUrl: '{{ssoTokenUrl}}', authorizationUrl: 'https://id.example.com/a' },
        },
      },
      authVars: { ssoTokenUrl: 'https://api.example.com/oauth/token' },
      authEnvironmentVars: { sandbox: { ssoTokenUrl: 'https://sandbox.example.com/oauth/token' } },
    })
    const engine = createEngine(reg as never)
    expect(await engine.oauthOf('sso', 'live', 0)).toMatchObject({
      tokenUrl: 'https://api.example.com/oauth/token',
    })
    expect(await engine.oauthOf('sso', 'sandbox', 0)).toMatchObject({
      tokenUrl: 'https://sandbox.example.com/oauth/token',
    })
  })
})
