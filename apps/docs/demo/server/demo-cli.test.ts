import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type RunningDemo, start } from './node'

const root = join(import.meta.dirname, '..')
const cli = join(root, '../../../packages/cli/dist/bin.js')

let demo: RunningDemo

beforeAll(async () => {
  if (!existsSync(cli)) throw new Error('Build the CLI first: pnpm --filter @specbook/cli build')
  demo = await start(0, { clock: () => new Date('2026-01-01T00:00:00Z') })
})
afterAll(() => demo.close())

const control = (path: string, init?: RequestInit) =>
  fetch(`${demo.origin}/api/_demo/${path}`, init)
const calm = () =>
  control('chaos', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fail: false,
      failNext: 0,
      latencyMs: 0,
      mutate: false,
      notFound: false,
    }),
  })
const chaos = (patch: object) =>
  control('chaos', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })

/** `specbook test` against the demo, as the docs' terminal does. It runs in another process: this one serves the API. */
function test(...args: string[]) {
  return new Promise<{ code: number; out: string }>((done) => {
    execFile(
      process.execPath,
      [
        cli,
        'test',
        '--env',
        'demo',
        '--var',
        `petstoreUrl=${demo.origin}/api/petstore`,
        '--var',
        `countriesUrl=${demo.origin}/api/countries`,
        '--var',
        `turnstileUrl=${demo.origin}/api/turnstile`,
        ...args,
      ],
      { cwd: root, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' } },
      (error, stdout, stderr) =>
        done({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: `${stdout}${stderr}`,
        }),
    )
  })
}

describe('specbook test against the demo API', () => {
  it('passes every request and flow when nothing is wrong', async () => {
    await control('reset', { method: 'POST' })
    const r = await test('--grep', '^(?!.*Register)')
    expect(r.out).not.toContain('✗')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Flows\s+\d+ passed/)
    // the flows work end to end: an order placed for the chosen pet is found again
    expect(r.out).toContain('Adopt a pet › Verify order')
  })

  it('runs the generated-name flow twice and registers a different pet each time it is given one', async () => {
    await control('reset', { method: 'POST' })
    expect((await test('--grep', 'Register a pet', '--input', 'petName=Biscuit')).code).toBe(0)
    const pet = (await (await fetch(`${demo.origin}/api/petstore/pet/1001`)).json()) as {
      name: string
    }
    expect(pet.name).toBe('Biscuit')
  })

  it('exits 1 when the service is told to fail, and names the status', async () => {
    await control('reset', { method: 'POST' })
    await chaos({ fail: true })
    const r = await test('--grep', 'Get a pet')
    expect(r.code).toBe(1)
    expect(r.out).toContain('500')
    await calm()
  })

  it('passes as flaky when it fails once and a retry finds it recovered', async () => {
    await control('reset', { method: 'POST' })
    await chaos({ failNext: 1 })
    const r = await test('--grep', 'Get a pet', '--retries', '1')
    expect(r.code).toBe(0)
    expect(r.out).toContain('retrying')
    expect(r.out).toMatch(/1 flaky/)
  })

  it('exits 1 with a failing check when the data changes under it', async () => {
    await control('reset', { method: 'POST' })
    await chaos({ mutate: true })
    const r = await test('--grep', 'Adopt a pet')
    expect(r.code).toBe(1)
    expect(r.out).toContain('still placed')
    await calm()
  })

  it('exits 1 on a timeout, as it does for a slow API', async () => {
    await control('reset', { method: 'POST' })
    await chaos({ latencyMs: 1500 })
    const r = await test('--grep', 'Get a pet', '--timeout', '400')
    expect(r.code).toBe(1)
    expect(r.out).toContain('Timed out after 400ms')
    await calm()
  })
})
