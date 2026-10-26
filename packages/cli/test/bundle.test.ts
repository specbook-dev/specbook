import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bundleCommand, isBrowserBody } from '../src/commands/bundle'
import { createLoader, type Loader } from '../src/load'
import { loadProject, type Project } from '../src/project'
import { fakeApi } from './fake-api'

const example = resolve(__dirname, '../../../apps/example')

const ops = {
  api: {
    GetPet: { service: 'api', id: 'GetPet', method: 'GET', path: '/pet/{id}' },
    Health: { service: 'api', id: 'Health', method: 'GET', path: '/health' },
    CreatePet: { service: 'api', id: 'CreatePet', method: 'POST', path: '/pets', encoding: 'json' },
  },
}

let server: Server
let dir: string
let project: Project
let loader: Loader
let base: string
let posted: string[] = []

const quiet = async <T>(f: () => Promise<T>) => {
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
  ]
  try {
    return await f()
  } finally {
    for (const s of spies) s.mockRestore()
  }
}

/** Runs a built file in an empty folder, as a machine with nothing but node would. */
async function runFile(file: string, args: string[], env: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'sb-empty-'))
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(
      process.execPath,
      [file, ...args],
      { cwd, env: { PATH: process.env.PATH, ...env } },
      (error, out, err) =>
        done({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out, err }),
    )
  })
}

const outFile = async () => join(await mkdtemp(join(tmpdir(), 'sb-bundle-')), 'tests.mjs')

beforeAll(async () => {
  server = createServer((rq, res) => {
    res.setHeader('content-type', 'application/json')
    if (rq.method === 'POST') {
      let body = ''
      rq.on('data', (c) => (body += c))
      rq.on('end', () => {
        posted.push(body)
        res.statusCode = 201
        res.end('{}')
      })
      return
    }
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  dir = await mkdtemp(join(tmpdir(), 'sb-bundle-src-'))
  const files: Record<string, string> = {
    '.specbook/specbook.config.ts': `import { defineConfig } from '@specbook/core'
import { SECRET_HEADER } from './helpers'
export default defineConfig({
  project: 'tmp',
  vars: { apiUrl: ${JSON.stringify(base)} },
  secrets: { API_KEY: {} },
  auth: { key: { apply: { headers: { [SECRET_HEADER]: '{{secrets.API_KEY}}' } } } },
  services: { api: { spec: './api.json', baseUrl: '{{apiUrl}}', auth: 'key' } },
})
`,
    '.specbook/helpers.ts': "export const SECRET_HEADER = 'x-api-key'\n",
    '.specbook/environments/staging.env': 'apiUrl=http://staging.example\n',
    '.specbook/environments/staging.secrets.env': 'API_KEY=do-not-ship\n',
    '.specbook/secrets.local.env': 'API_KEY=do-not-ship-either\n',
    '.generated/api/opmeta.json': JSON.stringify(ops.api),
    'requests/get-pet.req.ts':
      "import { GetPet } from '#api/api'\nexport default GetPet.request({ name: 'Get pet', tags: ['smoke'], path: { id: 1 } })\n",
    'requests/create-pet.req.ts':
      "import { CreatePet } from '#api/api'\nexport default CreatePet.request({ name: 'Create pet', tags: ['write'], example: 'rex' })\n",
    'requests/api/CreatePet/rex.example.json': '{"body":{"name":"rex-from-the-example"}}',
    // faker is only reached through a helper: nothing in the request's own text says so
    '.specbook/names.ts':
      "import { faker } from '@specbook/core/faker'\nexport const petName = () => faker.person.firstName()\n",
    'requests/gen.req.ts': `import { CreatePet } from '#api/api'
import { petName } from '../.specbook/names'
export default CreatePet.request({ name: 'Generated', tags: ['gen'], init: { who: () => petName() }, data: { name: '{{who}}' } })
`,
    'requests/health.req.ts':
      "import { Health } from '#api/api'\nexport default Health.request({ name: 'Health', tags: ['monitor'] })\n",
    'sequences/s.seq.ts': `import { sequence } from '@specbook/core'
import get from '../requests/get-pet.req'
export default sequence({ id: 's', title: 'S', tags: ['smoke'] }).step('get', get)
`,
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  await symlink(join(example, 'node_modules'), join(dir, 'node_modules'))
  loader = await createLoader(dir, { plugins: [fakeApi(ops)] })
  project = await loadProject(dir, loader)
}, 60_000)

afterAll(async () => {
  await loader.close()
  await new Promise<void>((r) => server.close(() => r()))
})

describe('specbook bundle', () => {
  it('compiles the tests into one file that runs with just node', async () => {
    const out = await outFile()
    expect(await quiet(() => bundleCommand(project, loader, { out, tags: [] }))).toBe(0)
    const text = await readFile(out, 'utf8')
    // no secret, and none of the environment's secret files, goes in
    expect(text).not.toContain('do-not-ship')
    // its hash is written beside it in the form sha256sum checks
    expect(await readFile(`${out}.sha256`, 'utf8')).toBe(
      `${createHash('sha256').update(text).digest('hex')}  tests.mjs\n`,
    )
    expect((await stat(out)).mode & 0o111).not.toBe(0)

    const r = await runFile(out, ['--env', 'live'], { API_KEY: 'a-key-from-the-environment' })
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/bundle \S* ?built \d{4}-\d{2}-\d{2}/)
    expect(r.out).toMatch(/Flows\s+5 passed/)
    // the example the request names was compiled in, and is what the request sent
    expect(posted.some((b) => b.includes('rex-from-the-example'))).toBe(true)
  }, 60_000)

  it('can be limited to a tag', async () => {
    const out = await outFile()
    expect(await quiet(() => bundleCommand(project, loader, { out, tags: ['monitor'] }))).toBe(0)
    const r = await runFile(out, ['--env', 'live', '--list'])
    expect(r.out).toContain('Health')
    expect(r.out).not.toContain('Get pet')
    expect(await quiet(() => bundleCommand(project, loader, { out, tags: ['nothing'] }))).toBe(3)
  }, 60_000)

  it('carries faker only when the tests use it, even through a helper', async () => {
    const plain = await outFile()
    const generated = await outFile()
    expect(await quiet(() => bundleCommand(project, loader, { out: plain, tags: ['smoke'] }))).toBe(
      0,
    )
    expect(
      await quiet(() => bundleCommand(project, loader, { out: generated, tags: ['gen'] })),
    ).toBe(0)
    // faker's English name data is in one and not the other
    expect(await readFile(plain, 'utf8')).not.toContain('Aaliyah')
    expect(await readFile(generated, 'utf8')).toContain('Aaliyah')
    expect((await stat(generated)).size).toBeGreaterThan((await stat(plain)).size * 3)
    // and the one that has it runs: the request sends a generated name
    posted = []
    const r = await runFile(generated, ['--env', 'live'], { API_KEY: 'k' })
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    const sent = JSON.parse(posted.at(-1) ?? '{}')
    expect(sent.name).toMatch(/^[A-Z][a-z]+$/)
  }, 90_000)

  it('takes the same flags as specbook test, with the same exit codes', async () => {
    const out = await outFile()
    await quiet(() => bundleCommand(project, loader, { out, tags: [] }))
    // the secret is missing
    const missing = await runFile(out, ['--env', 'live', '--grep', 'Get pet'])
    expect(missing.code).toBe(2)
    expect(missing.err).toContain('Missing secrets for "live"')
    expect(missing.err).not.toContain('secrets.env')
    const env = { API_KEY: 'k' }
    // writes are refused with --safe and sent without it
    posted = []
    const refused = await runFile(out, ['--env', 'live', '--safe', '--grep', 'Create pet'], env)
    expect(refused.code).toBe(1)
    expect(refused.out).toContain('Refusing POST /pets')
    expect(posted).toEqual([])
    expect((await runFile(out, ['--env', 'live', '--grep', 'Create pet'], env)).code).toBe(0)
    // usage
    expect((await runFile(out, ['--env', 'nowhere'], env)).code).toBe(3)
    expect((await runFile(out, ['--nope'], env)).code).toBe(3)
    // there is no mock in a bundle
    const mock = await runFile(out, ['--grep', 'Get pet'], env)
    expect(mock.code).toBe(2)
    expect(mock.err).toContain('mock environment is for development')
    expect((await runFile(out, ['--help'])).out).toContain('--safe')
  }, 90_000)

  it('stops at an import that is no operation of the spec', async () => {
    await writeFile(
      join(dir, 'requests/typo.req.ts'),
      "import { Nope } from '#api/api'\nexport default Nope.request({})\n",
    )
    const out = await outFile()
    try {
      expect(await quiet(() => bundleCommand(project, loader, { out, tags: [] }))).toBe(2)
    } finally {
      await writeFile(join(dir, 'requests/typo.req.ts'), '')
    }
  }, 60_000)
})

describe('specbook bundle with scripts', () => {
  let dir2: string
  let loader2: Loader
  let project2: Project

  beforeAll(async () => {
    dir2 = await mkdtemp(join(tmpdir(), 'sb-bundle-scripts-'))
    const files: Record<string, string> = {
      '.specbook/specbook.config.ts': `import { defineConfig } from '@specbook/core'
export default defineConfig({
  project: 'tmp',
  vars: { apiUrl: ${JSON.stringify(base)} },
  services: { api: { spec: './api.json', baseUrl: '{{apiUrl}}' } },
})
`,
      '.generated/api/opmeta.json': JSON.stringify(ops.api),
      'requests/get-pet.req.ts':
        "import { GetPet } from '#api/api'\nexport default GetPet.request({ name: 'Get pet', path: { id: 1 } })\n",
      // a browser script: its body, and the SDK the body imports, must stay out of the file
      'scripts/pay.script.ts': `import { script, withMock } from '@specbook/core'
export default withMock(
  script({
    id: 'pay',
    name: 'Pay',
    runtime: 'browser',
    load: () => import('./pay.browser'),
  }),
  () => ({ nonce: 'a-nonce' }),
)
`,
      'scripts/pay.browser.ts': `import { shim } from './sdk-shim'
export const run = async () => ({ nonce: 'BROWSER-BODY-MARKER' + shim })
`,
      'scripts/sdk-shim.ts': "export const shim = 'SDK-SHIM-MARKER'\n",
      // an isomorphic one: its body is part of the file
      'scripts/digest.script.ts': `import { c, script, withMock } from '@specbook/core'
export default withMock(
  script({
    id: 'digest',
    name: 'Digest',
    runtime: 'isomorphic',
    inputs: { text: c.text({ default: 'abc' }) },
    run: async ({ text }) => ({ digest: 'ISOMORPHIC-BODY-MARKER:' + text.length }),
  }),
  () => ({ digest: '' }),
)
`,
      'sequences/checkout.seq.ts': `import { sequence } from '@specbook/core'
import get from '../requests/get-pet.req'
import pay from '../scripts/pay.script'
export default sequence({ id: 'checkout', title: 'Checkout flow' }).step('Get pet', get).step('Pay', pay)
`,
      'sequences/digest.seq.ts': `import { sequence } from '@specbook/core'
import digest from '../scripts/digest.script'
export default sequence({ id: 'digest', title: 'Digest flow' })
  .step('Digest', digest)
  .check('Counted', (ctx, { assert }) => assert.is(ctx.captured.digest, 'ISOMORPHIC-BODY-MARKER:3', 'counted'))
`,
    }
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(dir2, path, '..'), { recursive: true })
      await writeFile(join(dir2, path), text)
    }
    await symlink(join(example, 'node_modules'), join(dir2, 'node_modules'))
    loader2 = await createLoader(dir2, { plugins: [fakeApi(ops)] })
    project2 = await loadProject(dir2, loader2)
  }, 60_000)

  afterAll(async () => {
    await loader2.close()
  })

  it('stubs the project’s browser bodies and not a dependency’s file of that name', () => {
    expect(isBrowserBody('/p/scripts/pay.browser.ts')).toBe(true)
    expect(isBrowserBody('/p/node_modules/dep/index.browser.js')).toBe(false)
  })

  it('leaves a browser body and the SDK it imports out of the file, and keeps an isomorphic body', async () => {
    const out = await outFile()
    expect(await quiet(() => bundleCommand(project2, loader2, { out, tags: [] }))).toBe(0)
    const text = await readFile(out, 'utf8')
    expect(text).not.toContain('BROWSER-BODY-MARKER')
    expect(text).not.toContain('SDK-SHIM-MARKER')
    expect(text).toContain('ISOMORPHIC-BODY-MARKER')
  })

  it('skips the flow that needs a browser when it runs, and runs the one that does not', async () => {
    const out = await outFile()
    await quiet(() => bundleCommand(project2, loader2, { out, tags: [] }))
    const r = await runFile(out, ['--env', 'live'])
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain('– Checkout flow  skipped: Needs a browser')
    expect(r.out).toContain('✓ Digest flow › Digest')
    expect(r.out).toContain('✓ Digest flow › Counted')
    // a script is a target on its own: the isomorphic one runs, the browser one is skipped
    expect(r.out).toContain('– Pay  skipped: Needs a browser')
    expect(r.out).toContain('✓ Digest')
    // the request runs on its own as well as in the flow that is skipped
    expect(r.out).toMatch(/Flows\s+3 passed \| 2 skipped/)
  })
})
