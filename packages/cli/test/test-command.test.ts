import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stripAnsi } from '@specbook/core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type TestCommandOptions, testCommand } from '../src/commands/test'
import { createLoader, type Loader } from '../src/load'
import { loadProject, type Project } from '../src/project'
import { fakeApi } from './fake-api'

const example = resolve(__dirname, '../../../apps/example')
const SECRET = 'sk_live/abc+123xyz'

const ops = {
  api: {
    GetPet: { service: 'api', id: 'GetPet', method: 'GET', path: '/pet/{id}' },
    Slow: { service: 'api', id: 'Slow', method: 'GET', path: '/slow' },
    Flaky: { service: 'api', id: 'Flaky', method: 'GET', path: '/flaky' },
    CreatePet: {
      service: 'api',
      id: 'CreatePet',
      method: 'POST',
      path: '/pets',
      encoding: 'json',
    },
    Search: { service: 'api', id: 'Search', method: 'POST', path: '/search', encoding: 'json' },
  },
}

let server: Server
let base: string
let flakyCalls = 0
let posts = 0

let dir: string
let project: Project
let loader: Loader

const req = (op: string, body: string) =>
  `import { ${op} } from '#api/api'\nexport default ${op}.request(${body})\n`

beforeAll(async () => {
  server = createServer((rq, res) => {
    res.setHeader('content-type', 'application/json')
    const url = rq.url ?? ''
    if (rq.method === 'POST') posts++
    if (url === '/pet/1')
      return void res.end(JSON.stringify({ id: 1, name: 'Rex', echo: rq.headers['x-api-key'] }))
    if (url === '/pet/9') {
      res.statusCode = 404
      return void res.end(JSON.stringify({ message: 'no such pet' }))
    }
    if (url.startsWith('/v2/')) {
      res.statusCode = 404
      return void res.end(JSON.stringify({ message: 'nope' }))
    }
    if (url === '/flaky') {
      res.statusCode = ++flakyCalls === 1 ? 500 : 200
      return void res.end('{}')
    }
    if (url === '/slow') return void setTimeout(() => res.end('{}'), 600)
    res.statusCode = rq.method === 'POST' ? 201 : 200
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  dir = await mkdtemp(join(tmpdir(), 'sb-test-'))
  const files: Record<string, string> = {
    '.specbook/specbook.config.ts': `import { defineConfig } from '@specbook/core'
export default defineConfig({
  project: 'tmp',
  vars: { apiUrl: ${JSON.stringify(base)} },
  secrets: { API_KEY: {} },
  auth: { key: { apply: { headers: { 'x-api-key': '{{secrets.API_KEY}}' } } } },
  services: { api: { spec: './api.json', baseUrl: '{{apiUrl}}', auth: 'key' } },
})
`,
    'requests/get-pet.req.ts': req(
      'GetPet',
      "{ name: 'Get pet', tags: ['smoke'], path: { id: 1 } }",
    ),
    'requests/missing.req.ts': req(
      'GetPet',
      "{ name: 'Missing pet', tags: ['smoke'], path: { id: 9 } }",
    ),
    'requests/echo.req.ts': req(
      'GetPet',
      "{ name: 'Echo', path: { id: 1 }, assert: (res, { assert }) => assert.is((res.data as any).echo, 'nope', 'echoes nothing') }",
    ),
    'requests/create.req.ts': req('CreatePet', "{ name: 'Create pet', data: { name: 'x' } }"),
    'requests/search.req.ts': req('Search', "{ name: 'Search', safe: true, data: { q: 'x' } }"),
    'requests/flaky.req.ts': req('Flaky', "{ name: 'Flaky', tags: ['flaky'] }"),
    'requests/slow.req.ts': req('Slow', "{ name: 'Slow', tags: ['slow'], timeoutMs: 150 }"),
    'requests/slow-default.req.ts': req('Slow', "{ name: 'Slow default', tags: ['slow-default'] }"),
    'sequences/pets.seq.ts': `import { sequence } from '@specbook/core'
import get from '../requests/get-pet.req'
import missing from '../requests/missing.req'
export default sequence({ id: 'pets', title: 'Pets', tags: ['smoke'], continueOnFailure: true })
  .step('Get', get)
  .step('Missing', missing)
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

const base0: TestCommandOptions = {
  patterns: [],
  env: 'live',
  inputs: {},
  vars: {},
  reporters: [],
  tags: [],
}

/** Runs the command and returns the exit code with everything it printed. */
async function run(o: Partial<TestCommandOptions> = {}) {
  const out: string[] = []
  const err: string[] = []
  const w = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    out.push(String(c))
    return true
  })
  const l = vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(`${a.join(' ')}\n`))
  const e = vi
    .spyOn(console, 'error')
    .mockImplementation((...a) => void err.push(`${a.join(' ')}\n`))
  try {
    const code = await testCommand(project, loader, { ...base0, ...o })
    // a CI log gets color, which is not what is being compared
    return { code, out: stripAnsi(out.join('')), err: stripAnsi(err.join('')) }
  } finally {
    w.mockRestore()
    l.mockRestore()
    e.mockRestore()
  }
}

describe('specbook test', () => {
  afterEach(() => {
    delete process.env.API_KEY
  })

  it('passes a smoke test against a live environment, with the secret only in the environment', async () => {
    process.env.API_KEY = SECRET
    const r = await run({ tags: ['smoke'], grep: 'Get pet' })
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain('✓ Get pet  GET /pet/1  200')
    expect(r.out).toMatch(/Flows\s+1 passed/)
  })

  it('fails a request with no assert on a 404, says why, and never prints the secret', async () => {
    process.env.API_KEY = SECRET
    const dirOut = join(dir, 'reports')
    const r = await run({
      patterns: ['requests/missing.req.ts', 'requests/echo.req.ts'],
      reporters: [
        'list',
        `junit:${dirOut}/junit.xml`,
        `json:${dirOut}/report.json`,
        `ndjson:${dirOut}/events.ndjson`,
      ],
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain('FAIL')
    expect(r.out).toContain('status 404 Not Found')
    expect(r.out).toContain(`GET ${base}/pet/9`)
    expect(r.out).toContain('Re-run: specbook test requests/missing.req.ts --env live')
    for (const file of ['junit.xml', 'report.json', 'events.ndjson']) {
      const text = await readFile(join(dirOut, file), 'utf8')
      for (const form of [SECRET, encodeURIComponent(SECRET), btoa(SECRET)])
        expect(text, file).not.toContain(form)
    }
    const all = r.out + r.err
    for (const form of [SECRET, encodeURIComponent(SECRET), btoa(SECRET)])
      expect(all).not.toContain(form)
    // the echoed secret was in a failed assertion's actual value: it shows masked
    expect(await readFile(join(dirOut, 'report.json'), 'utf8')).toContain('"***"')
    const report = JSON.parse(await readFile(join(dirOut, 'report.json'), 'utf8'))
    expect(report.schemaVersion).toBe(2)
    expect(report.totals.flows.failed).toBe(2)
    expect(report.services.api).toBe(base)
    // ndjson went to its file, not to the screen
    expect(r.out).not.toContain('"type":"step:start"')
    expect(await readFile(join(dirOut, 'events.ndjson'), 'utf8')).toContain('"type":"summary"')
    expect(await readFile(join(dirOut, 'junit.xml'), 'utf8')).toContain('<failure')
  })

  it('writes by default, and with --safe refuses to, but lets a POST marked safe through', async () => {
    process.env.API_KEY = SECRET
    posts = 0
    const refused = await run({ patterns: ['requests/create.req.ts'], safe: true })
    expect(refused.code).toBe(1)
    expect(refused.out).toContain('Refusing POST /pets in "live"')
    expect(posts).toBe(0)
    const safe = await run({ patterns: ['requests/search.req.ts'], safe: true })
    expect(safe.code).toBe(0)
    const allowed = await run({ patterns: ['requests/create.req.ts'] })
    expect(allowed.code).toBe(0)
    expect(posts).toBe(2)
  })

  it('--var changes an address too: the request goes where the variable says', async () => {
    process.env.API_KEY = SECRET
    const other = createServer((_, res) => {
      hitsElsewhere++
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: 1, name: 'Elsewhere' }))
    })
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
    const elsewhere = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
    let hitsElsewhere = 0
    try {
      const r = await run({
        patterns: ['requests/get-pet.req.ts'],
        vars: { apiUrl: elsewhere },
      })
      expect(r.code).toBe(0)
      expect(hitsElsewhere).toBe(1)
      expect(r.out).toContain('Get pet')
    } finally {
      await new Promise<void>((r) => other.close(() => r()))
    }
  })

  it('shows the address a failed request went to, base path included, and keeps the report to the origin', async () => {
    process.env.API_KEY = SECRET
    const dirOut = join(dir, 'reports-v2')
    const r = await run({
      patterns: ['requests/get-pet.req.ts'],
      vars: { apiUrl: `${base}/v2` },
      reporters: ['list', `json:${dirOut}/report.json`, `junit:${dirOut}/junit.xml`],
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain(`GET ${base}/v2/pet/1`)
    expect(await readFile(join(dirOut, 'junit.xml'), 'utf8')).toContain(`${base}/v2/pet/1`)
    // the report's address stays an origin
    const report = JSON.parse(await readFile(join(dirOut, 'report.json'), 'utf8'))
    expect(report.services.api).toBe(base)
  })

  it('retries a failed flow and reports it flaky, exiting 0', async () => {
    process.env.API_KEY = SECRET
    flakyCalls = 0
    const r = await run({ patterns: ['requests/flaky.req.ts'], retries: 1 })
    expect(r.code).toBe(0)
    expect(r.out).toContain('retrying Flaky (attempt 2 of 2)')
    expect(r.out).toMatch(/1 flaky/)
    flakyCalls = 0
    expect((await run({ patterns: ['requests/flaky.req.ts'] })).code).toBe(1)
  })

  it('treats a timeout as a failure with the reason, not as a crash', async () => {
    process.env.API_KEY = SECRET
    const r = await run({ patterns: ['requests/slow.req.ts'] })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/FAIL[\s\S]*Slow/)
  })

  it('gives a request the time the project says, and --timeout says over that', async () => {
    process.env.API_KEY = SECRET
    const slow = { patterns: ['requests/slow-default.req.ts'] }
    // the server takes 600 ms to answer: a project that allows 100 ms times it out, naming the time
    project.config.timeoutMs = 100
    try {
      const short = await run(slow)
      expect(short.code).toBe(1)
      expect(short.out).toContain('Timed out after 100ms')
      // the flag wins over the project, either way
      expect((await run({ ...slow, timeoutMs: 3_000 })).code).toBe(0)
      project.config.timeoutMs = 3_000
      expect((await run(slow)).code).toBe(0)
      expect((await run({ ...slow, timeoutMs: 100 })).out).toContain('Timed out after 100ms')
      // and 0 waits for as long as it takes
      expect((await run({ ...slow, timeoutMs: 0 })).code).toBe(0)
    } finally {
      delete project.config.timeoutMs
    }
  })

  it('selects by tag, grep and shard, lists without running, and stops at --bail', async () => {
    process.env.API_KEY = SECRET
    const listed = await run({ list: true })
    expect(listed.code).toBe(0)
    expect(listed.out).toContain('requests/get-pet.req.ts › Get pet  [smoke]')
    expect(listed.out).toMatch(/\d+ tests/)
    const all = listed.out.split('\n').filter((l) => l.includes(' › '))
    const first = (await run({ list: true, shard: '1/2' })).out
    const second = (await run({ list: true, shard: '2/2' })).out
    const halves = [...first.split('\n'), ...second.split('\n')].filter((l) => l.includes(' › '))
    expect(halves.sort()).toEqual(all.sort())
    expect((await run({ list: true, tags: ['slow'] })).out).toContain('Slow')
    expect((await run({ list: true, grep: 'echo', grepInvert: 'zzz' })).out).toMatch(/1 test\b/)
    expect((await run({ list: true, grep: '(' })).code).toBe(3)
    expect((await run({ list: true, shard: '3/2' })).code).toBe(3)

    const bailed = await run({
      patterns: ['requests/missing.req.ts', 'requests/echo.req.ts', 'requests/get-pet.req.ts'],
      bail: 1,
    })
    expect(bailed.code).toBe(1)
    expect(bailed.err).toContain('stopped after 1 failed flow (--bail)')
    expect(bailed.out).not.toContain('Get pet')
  })

  it('cannot run without its secrets, an operation, or a known environment', async () => {
    delete process.env.API_KEY
    const noSecret = await run({ patterns: ['requests/get-pet.req.ts'] })
    expect(noSecret.code).toBe(2)
    expect(noSecret.err).toContain('Missing secrets for "live"')
    expect(noSecret.err).toContain('API_KEY')
    expect((await run({ env: 'nowhere' })).code).toBe(3)
    expect((await run({ reporters: ['teapot'] })).err).toContain('Unknown reporter "teapot"')
    expect((await run({ patterns: ['nothing/*.ts'] })).code).toBe(3)
  })
})
