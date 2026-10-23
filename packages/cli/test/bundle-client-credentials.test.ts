import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
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
const CLIENT_ID = 'monitor-client'
const CLIENT_SECRET = 'cs_bundle/secret+9'
const TOKEN = 'bundle-access-token-456'

const ops = { api: { GetThing: { service: 'api', id: 'GetThing', method: 'GET', path: '/thing' } } }

let server: Server
let dir: string
let project: Project
let loader: Loader
let tokenRequests = 0

/** Runs a built file in an empty folder, as a machine with nothing but node would. */
function runFile(file: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(
      process.execPath,
      [file, ...args],
      { cwd: tmpdir(), env: { PATH: process.env.PATH, ...env } },
      (error, out, err) =>
        done({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out, err }),
    )
  })
}

beforeAll(async () => {
  server = createServer((rq, res) => {
    res.setHeader('content-type', 'application/json')
    let body = ''
    rq.on('data', (c) => {
      body += c
    })
    rq.on('end', () => {
      if (rq.url === '/oauth/token') {
        tokenRequests++
        const form = new URLSearchParams(body)
        if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
          res.statusCode = 401
          return void res.end(JSON.stringify({ error: 'invalid_client' }))
        }
        return void res.end(JSON.stringify({ access_token: TOKEN, expires_in: 300 }))
      }
      res.statusCode = rq.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401
      res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  dir = await mkdtemp(join(tmpdir(), 'sb-bundle-cc-'))
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
    '.generated/api/opmeta.json': JSON.stringify(ops.api),
    'requests/thing.req.ts':
      "import { GetThing } from '#api/api'\nexport default GetThing.request({ name: 'Thing', tags: ['monitor'] })\n",
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

describe('a bundle with a client credentials profile', () => {
  it('fetches its token with secrets from the environment alone, and carries none of them', async () => {
    const out = join(await mkdtemp(join(tmpdir(), 'sb-bundle-')), 'tests.mjs')
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    ]
    try {
      expect(await bundleCommand(project, loader, { out, tags: [] })).toBe(0)
    } finally {
      for (const s of spies) s.mockRestore()
    }
    const text = await readFile(out, 'utf8')
    expect(text).not.toContain(CLIENT_SECRET)

    tokenRequests = 0
    const ok = await runFile(out, ['--env', 'live', '--safe'], {
      CC_ID: CLIENT_ID,
      CC_SECRET: CLIENT_SECRET,
    })
    expect(ok.err).toBe('')
    expect(ok.code).toBe(0)
    expect(tokenRequests).toBe(1)
    expect(ok.out + ok.err).not.toContain(CLIENT_SECRET)
    expect(ok.out + ok.err).not.toContain(TOKEN)

    // a monitor missing its secret says which, and does not call the provider
    tokenRequests = 0
    const missing = await runFile(out, ['--env', 'live'], { CC_ID: CLIENT_ID })
    expect(missing.code).toBe(2)
    expect(missing.err).toContain('CC_SECRET')
    expect(tokenRequests).toBe(0)
  }, 90_000)
})
