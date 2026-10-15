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

  it('puts each server under its own name, with the descriptions as environment notes', async () => {
    const reg = await registryFor(opened(servers))
    const cfg = (await reg.loadConfig()).default as any
    expect(cfg.services.shop.baseUrl).toEqual({
      live: 'https://api.example.com/v1',
      sandbox: 'https://sandbox.example.com/v1',
      eu: 'https://eu.example.com/v1',
    })
    expect(cfg.environments).toEqual({
      live: { description: 'Production' },
      sandbox: { description: 'Test data' },
    })

    const engine = createEngine(reg as never)
    expect(await engine.environments(0)).toEqual(['mock', 'live', 'sandbox', 'eu'])
    expect(await engine.environmentNotes(0)).toEqual({
      live: 'Production',
      sandbox: 'Test data',
    })
  })

  it('lets the address a person typed replace `live` and nothing else', async () => {
    const reg = await registryFor(opened(servers), 'https://mine.example.com')
    const cfg = (await reg.loadConfig()).default as any
    expect(cfg.services.shop.baseUrl.live).toBe('https://mine.example.com')
    expect(cfg.services.shop.baseUrl.sandbox).toBe('https://sandbox.example.com/v1')
  })

  it('keeps a single-server document exactly as it was: mock and live', async () => {
    const reg = await registryFor(opened([{ name: 'live', url: 'https://api.example.com' }]))
    const cfg = (await reg.loadConfig()).default as any
    expect(cfg.environments).toBeUndefined()
    expect(await createEngine(reg as never).environments(0)).toEqual(['mock', 'live'])
  })

  it('has no live environment until the person gives an address, but still offers the other servers', async () => {
    const reg = await registryFor({
      ...opened([{ name: 'sandbox', url: 'https://sandbox.example.com' }]),
      needsBaseUrl: true,
    })
    const cfg = (await reg.loadConfig()).default as any
    expect(Object.keys(cfg.services.shop.baseUrl)).toEqual(['sandbox'])
  })
})
