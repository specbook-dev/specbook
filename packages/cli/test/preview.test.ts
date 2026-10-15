import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { previewCommand } from '../src/commands/preview'

const petstore2 = resolve(__dirname, '../../codegen/test/fixtures/petstore2.json')

describe('preview', () => {
  it('serves the UI for a bare OpenAPI file with no project', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const p = await previewCommand(petstore2, { port: 0, open: false })
    afterAll(() => p.close())
    expect(p.url).toBeTruthy()
    const html = await (await fetch(p.url as string)).text()
    expect(html).toContain('<div id="app">')
    const registry = await (await fetch(`${p.url}@id/__x00__virtual:specbook/registry`)).text()
    expect(registry).toContain('"service":"swagger-petstore"')
    expect(registry).toContain('https://petstore.swagger.io/v2')
  }, 30_000)

  it('turns security schemes into credentials held in server memory', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = await mkdtemp(join(tmpdir(), 'sb-prev-auth-'))
    const file = join(dir, 'api.json')
    await writeFile(
      file,
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Locked', version: '1' },
        servers: [{ url: 'https://api.example.test' }],
        components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Key' } } },
        security: [{ key: [] }],
        paths: { '/a': { get: { operationId: 'A', responses: { '200': { description: 'ok' } } } } },
      }),
    )
    const p = await previewCommand(file, { port: 0, open: false })
    afterAll(() => p.close())
    const get = async (env = 'live') =>
      (await (await fetch(`${p.url}__specbook/environment?env=${env}`)).json()) as any

    expect((await get()).secrets).toEqual([{ name: 'KEY', key: 'KEY' }])

    const post = (path: string, body: object, headers: Record<string, string> = {}) =>
      fetch(`${p.url}__specbook/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    expect((await post('secret', { name: 'NOPE', value: 'x' })).status).toBe(400)
    expect(
      (await post('secret', { name: 'KEY', value: 'x' }, { origin: 'http://evil.test' })).status,
    ).toBe(403)

    // session only
    expect((await post('secret', { name: 'KEY', value: 'sk_1', env: 'live' })).status).toBe(200)
    expect((await get()).secrets[0].source).toBe('session')
    await post('secret', { name: 'KEY', value: '', env: 'live' })
    expect((await get()).secrets[0].source).toBeUndefined()

    // remembered for one environment: written to that environment's file only
    await post('secret', { name: 'KEY', value: 'sk_live', env: 'live', scope: 'environment' })
    expect((await get('live')).secrets[0].source).toBe('environment')
    expect((await get('staging')).secrets[0].source).toBeUndefined()
    const { readFile } = await import('node:fs/promises')
    const read = (f: string) => readFile(join(p.root, '.specbook', f), 'utf8')
    expect(await read('environments/live.secrets.env')).toBe('KEY=sk_live\n')
    expect(await read('environments/.gitignore')).toContain('*.secrets.env')

    // shared across environments
    await post('secret', { name: 'KEY', value: 'sk_shared', scope: 'shared' })
    expect((await get('staging')).secrets[0].source).toBe('shared')
    expect((await get('live')).secrets[0].source).toBe('environment')

    // variables are written to the committed file, and a secret there is called out
    await post('var', { env: 'staging', name: 'region', value: 'eu-west-1' })
    expect((await get('staging')).vars).toEqual({ region: 'eu-west-1' })
    await post('var', { env: 'staging', name: 'KEY', value: 'oops' })
    expect((await get('staging')).warnings[0]).toContain('is a secret but is in staging.env')
    await post('var', { env: 'staging', name: 'region', value: null })
    expect((await get('staging')).vars).toEqual({ KEY: 'oops' })

    expect((await post('var', { env: '../x', name: 'a', value: 'b' })).status).toBe(400)
    expect(await read('secrets.local.env')).toBe('KEY=sk_shared\n')
  }, 30_000)

  it('shows the logo the spec declares in info.x-logo', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = await mkdtemp(join(tmpdir(), 'sb-prev-logo-'))
    const file = join(dir, 'api.json')
    await writeFile(
      file,
      JSON.stringify({
        openapi: '3.0.3',
        info: {
          title: 'Branded',
          version: '1',
          'x-logo': { url: 'https://cdn.example.test/logo.svg', backgroundColor: '#112233' },
        },
        paths: { '/a': { get: { operationId: 'A', responses: { '200': { description: 'ok' } } } } },
      }),
    )
    const p = await previewCommand(file, { port: 0, open: false })
    afterAll(() => p.close())
    const registry = await (await fetch(`${p.url}@id/__x00__virtual:specbook/registry`)).text()
    expect(registry).toContain('"logo":{"url":"https://cdn.example.test/logo.svg"')
    expect(registry).toContain('"backgroundColor":"#112233"')
  }, 30_000)
})
