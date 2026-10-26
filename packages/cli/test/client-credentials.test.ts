import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stripAnsi } from '@specbook/core/internal'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type TestCommandOptions, testCommand } from '../src/commands/test'
import { createLoader, type Loader } from '../src/load'
import { loadProject, type Project } from '../src/project'
import { fakeApi } from './fake-api'

const example = resolve(__dirname, '../../../apps/example')
const CLIENT_ID = 'monitor-client'
const CLIENT_SECRET = 'cs_live/very+secret=1'
const TOKEN = 'access-token-value-123'

const ops = { api: { GetThing: { service: 'api', id: 'GetThing', method: 'GET', path: '/thing' } } }

let server: Server
let tokenRequests: { auth?: string; body: string }[] = []
let dir: string
let project: Project
let loader: Loader

beforeAll(async () => {
  server = createServer((rq, res) => {
    res.setHeader('content-type', 'application/json')
    let body = ''
    rq.on('data', (c) => {
      body += c
    })
    rq.on('end', () => {
      if (rq.url === '/oauth/token' && rq.method === 'POST') {
        tokenRequests.push({ auth: rq.headers.authorization, body })
        const form = new URLSearchParams(body)
        const basic = rq.headers.authorization === `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`
        const inBody =
          form.get('client_id') === CLIENT_ID && form.get('client_secret') === CLIENT_SECRET
        if (form.get('grant_type') !== 'client_credentials' || !(basic || inBody)) {
          res.statusCode = 401
          return void res.end(JSON.stringify({ error: 'invalid_client' }))
        }
        return void res.end(
          JSON.stringify({ access_token: TOKEN, token_type: 'Bearer', expires_in: 300 }),
        )
      }
      if (rq.url === '/thing') {
        res.statusCode = rq.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401
        return void res.end('{}')
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  dir = await mkdtemp(join(tmpdir(), 'sb-cc-'))
  const files: Record<string, string> = {
    '.specbook/specbook.config.ts': `import { defineConfig } from '@specbook/core'
export default defineConfig({
  project: 'tmp',
  vars: { apiUrl: ${JSON.stringify(base)} },
  secrets: { CC_ID: {}, CC_SECRET: {} },
  auth: {
    cc: {
      apply: { headers: { authorization: 'Bearer {{session.accessToken}}' } },
      oauth: { tokenUrl: '{{apiUrl}}/oauth/token', clientId: '{{secrets.CC_ID}}', clientSecret: '{{secrets.CC_SECRET}}' },
    },
  },
  services: { api: { spec: './api.json', baseUrl: '{{apiUrl}}', auth: 'cc' } },
})
`,
    'requests/thing.req.ts': `import { GetThing } from '#api/api'\nexport default GetThing.request({ name: 'Thing' })\n`,
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

afterEach(() => {
  delete process.env.CC_ID
  delete process.env.CC_SECRET
  tokenRequests = []
})

const base0: TestCommandOptions = {
  patterns: ['requests/thing.req.ts'],
  env: 'live',
  inputs: {},
  vars: {},
  reporters: [],
  tags: [],
}

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
    return { code, out: stripAnsi(out.join('')), err: stripAnsi(err.join('')) }
  } finally {
    w.mockRestore()
    l.mockRestore()
    e.mockRestore()
  }
}

describe('a client credentials profile in specbook test', () => {
  it('fetches a token with the secrets from the environment and sends it, never printing them', async () => {
    process.env.CC_ID = CLIENT_ID
    process.env.CC_SECRET = CLIENT_SECRET
    const report = join(dir, 'reports/report.json')
    const r = await run({ reporters: ['list', `json:${report}`] })
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(tokenRequests).toHaveLength(1)
    const text = r.out + r.err + (await readFile(report, 'utf8'))
    for (const secret of [CLIENT_SECRET, encodeURIComponent(CLIENT_SECRET), TOKEN])
      expect(text).not.toContain(secret)
  })

  it('exits 2 and names the secret that is missing', async () => {
    process.env.CC_ID = CLIENT_ID
    const r = await run()
    expect(r.code).toBe(2)
    expect(r.err).toContain('CC_SECRET')
    expect(r.err).not.toContain('CC_ID')
    expect(tokenRequests).toHaveLength(0)
  })

  it('fails the flow, naming the profile, when the provider refuses the client', async () => {
    process.env.CC_ID = CLIENT_ID
    process.env.CC_SECRET = 'wrong'
    const r = await run()
    expect(r.code).toBe(1)
    expect(r.out).toContain('Token request for profile "cc" failed')
    expect(r.out).toContain('invalid_client')
  })

  it('does not call the provider in the mock environment', async () => {
    const r = await run({ env: 'mock' })
    expect(tokenRequests).toHaveLength(0)
    expect(r.err).toBe('')
  })
})
