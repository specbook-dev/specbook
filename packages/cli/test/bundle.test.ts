import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bundleCommand } from '../src/commands/bundle'
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
    expect(r.out).toMatch(/Flows\s+4 passed/)
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
