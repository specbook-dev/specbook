import { describe, expect, it } from 'vitest'
import config from '../demo/.specbook/specbook.config'
import findPets from '../demo/requests/petstore/find-pets.req'
import getPet from '../demo/requests/petstore/get-pet.req'
import adoptPet from '../demo/sequences/adopt-pet.seq'
import { createDemoApp } from '../demo/server/app'
import { memoryStore } from '../demo/server/store'
import { ansiToHtml } from '../src/lib/ansi'
import { runDemo } from '../src/lib/run-demo'

// the page's runner against the demo API, in process: what the terminal shows is what this prints
const envText = 'petstoreUrl=/api/petstore\ncountriesUrl=/api/countries\n'

async function run(extra: Partial<Parameters<typeof runDemo>[0]> = {}) {
  const store = memoryStore()
  const app = createDemoApp({ store, sleep: async () => {} })
  let out = ''
  const code = await runDemo({
    config,
    modules: [
      { file: 'requests/petstore/find-pets.req.ts', mod: { default: findPets } },
      { file: 'requests/petstore/get-pet.req.ts', mod: { default: getPet } },
      { file: 'sequences/adopt-pet.seq.ts', mod: { default: adoptPet } },
    ],
    env: 'demo',
    envText,
    fetch: async (input, init) =>
      app.fetch(new Request(new URL(String(input), 'https://docs.test'), init)),
    pageHref: 'https://docs.test/test/',
    version: '0.2.0',
    write: (s) => {
      out += s
    },
    ...extra,
  })
  return { code, out, app, store }
}

describe('the page runner', () => {
  it('passes against the demo API and prints like the CLI', async () => {
    const { code, out } = await run()
    expect(code).toBe(0)
    expect(out).toContain('specbook test 0.2.0')
    expect(out).toContain('env demo')
    expect(out).toContain('✓')
    expect(ansiToHtml(out)).toContain('class="a-green"')
  })

  it('a tag picks the runs that carry it, as --tag does', async () => {
    const { out } = await run({ tag: 'monitor' })
    expect(out).toContain('2/3 tests')
  })

  it('grep picks runs by title', async () => {
    const { out } = await run({ grep: 'adopt' })
    expect(out).toContain('1/3 tests')
  })

  const chaos = (app: Awaited<ReturnType<typeof run>>['app'], patch: object) =>
    app.fetch(
      new Request('https://docs.test/api/_demo/chaos', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    )

  it('fails with exit 1 when the API is down', async () => {
    const app = createDemoApp({ store: memoryStore(), sleep: async () => {} })
    await chaos(app, { fail: true })
    const { code, out } = await runWith(app)
    expect(code).toBe(1)
    expect(out).toContain('✗')
  })

  it('one failure and a retry is a pass, called flaky', async () => {
    const app = createDemoApp({ store: memoryStore(), sleep: async () => {} })
    await chaos(app, { failNext: 1 })
    const { code, out } = await runWith(app, { retries: 1 })
    expect(code).toBe(0)
    expect(out).toContain('retrying')
    expect(out).toMatch(/flaky/i)
  })
})

async function runWith(app: ReturnType<typeof createDemoApp>, extra: object = {}) {
  let out = ''
  const code = await runDemo({
    config,
    modules: [{ file: 'requests/petstore/find-pets.req.ts', mod: { default: findPets } }],
    env: 'demo',
    envText,
    fetch: async (input, init) =>
      app.fetch(new Request(new URL(String(input), 'https://docs.test'), init)),
    pageHref: 'https://docs.test/test/',
    version: '0.2.0',
    write: (s) => {
      out += s
    },
    ...extra,
  })
  return { code, out }
}
