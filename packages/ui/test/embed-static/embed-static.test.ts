import { execFileSync } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * What a docs page gets: the built `specbook.js` of a project, served same-origin under a strict policy that allows no
 * inline script or style and no eval. A relative address (`/api/petstore`) is answered by the page's own server, which is
 * the path a service worker answers on the docs site.
 */

const cli = resolve(import.meta.dirname, '../../../cli/dist/bin.js')
const example = resolve(import.meta.dirname, '../../../../apps/example')
// No inline script or style element and no eval. The code editors build their markup from templates that carry
// `style=""` attributes, so inline style *attributes* (not `<style>` elements) are allowed: `style-src-attr`.
const STRICT =
  "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; worker-src 'self'; base-uri 'self'; form-action 'self'"
const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

const HOST = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>host</title></head>
<body>
  <p data-specbook-try="petstore/FindPetsByStatus" data-specbook-env="demo">Find pets</p>
  <p data-specbook-flow="pets" data-specbook-env="demo">Pets flow</p>
  <script type="module" src="/specbook.js"></script>
</body></html>`

let root: string
let dist: string
let server: Server
let origin: string
let browser: Browser
const apiCalls: string[] = []

async function projectFiles(dir: string) {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'embed-static',
      type: 'module',
      imports: { '#api/*': './.generated/*/index.ts' },
    }),
    '.specbook/specbook.config.ts': `import { defineConfig } from '@specbook/core'
export default defineConfig({
  project: 'embed-static',
  vars: { petstoreUrl: 'https://petstore.example.test/api' },
  services: { petstore: { spec: './openapi/petstore.json', baseUrl: '{{petstoreUrl}}' } },
})
`,
    // the demo environment is the page's own origin: one file serves every host
    '.specbook/environments/demo.env': 'petstoreUrl=/api/petstore\n',
    'requests/find-pets.req.ts': `import { FindPetsByStatus } from '#api/petstore'
export default FindPetsByStatus.request({
  name: 'Find pets by status',
  init: { status: 'available' },
  query: { status: '{{status}}' },
  assert: (res, { assert }) => assert.is(res.status, 200, 'ok'),
})
`,
    'sequences/pets.seq.ts': `import { c, sequence } from '@specbook/core'
import findPets from '../requests/find-pets.req'
export default sequence({
  id: 'pets',
  title: 'Pets',
  inputs: { status: c.select(['available', 'sold'] as const, { default: 'available' }) },
}).step('Find pets', findPets)
`,
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  await mkdir(join(dir, 'openapi'), { recursive: true })
  await cp(join(example, 'openapi/petstore.json'), join(dir, 'openapi/petstore.json'))
  await symlink(join(example, 'node_modules'), join(dir, 'node_modules'))
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sb-embed-static-'))
  await projectFiles(root)
  execFileSync('node', [cli, 'build', '--minimal', '--out', 'dist'], { cwd: root, stdio: 'pipe' })
  dist = join(root, 'dist')

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname.startsWith('/api/petstore/')) {
      apiCalls.push(`${req.method} ${url.pathname}${url.search}`)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify([{ id: 1, name: 'Rex', photoUrls: [], status: 'available' }]))
      return
    }
    res.setHeader('content-security-policy', STRICT)
    if (url.pathname === '/' || url.pathname === '/host.html') {
      res.setHeader('content-type', 'text/html')
      res.end(HOST)
      return
    }
    try {
      const file = join(dist, url.pathname)
      if (!file.startsWith(dist)) throw new Error('outside')
      const body = await readFile(file)
      res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream')
      res.end(body)
    } catch {
      res.statusCode = 404
      res.end('not found')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((r) => server?.close(() => r()))
  await rm(root, { recursive: true, force: true })
})

async function open(): Promise<{ page: Page; problems: string[] }> {
  const page = await browser.newPage()
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`error: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`)
  })
  await page.addInitScript(() => {
    ;(window as unknown as { __csp: string[] }).__csp = []
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}:${e.columnNumber} ${e.sample}`,
      ),
    )
  })
  await page.goto(`${origin}/`)
  return { page, problems }
}

const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)

describe('the embed on a page with a strict policy', () => {
  it('runs a request against the page’s own origin, with no violation and no error', async () => {
    const { page, problems } = await open()
    apiCalls.length = 0
    await page.locator('specbook-play').first().locator('button').click()
    await page.locator('specbook-panel button[aria-label="Send"]').click()
    await expect
      .poll(() => page.locator('specbook-panel .response .state-badge').first().textContent(), {
        timeout: 30_000,
      })
      .toMatch(/200/)
    expect(apiCalls.some((c) => c.startsWith('GET /api/petstore/pet/findByStatus'))).toBe(true)
    expect(await violations(page)).toEqual([])
    expect(problems).toEqual([])
    await page.close()
  })

  it('runs a flow, on its defaults, under the same policy', async () => {
    const { page, problems } = await open()
    await page.locator('specbook-play').nth(1).locator('button').click()
    await page.getByRole('button', { name: 'Run with defaults' }).click()
    await expect
      .poll(() => page.locator('specbook-panel .seq-run .badge').first().textContent(), {
        timeout: 30_000,
      })
      .toContain('Passed')
    expect(await violations(page)).toEqual([])
    expect(problems).toEqual([])
    await page.close()
  })

  it('leaves nothing of the visitor in the page’s storage', async () => {
    const { page } = await open()
    await page.locator('specbook-play').first().locator('button').click()
    await page.locator('specbook-panel button[aria-label="Send"]').click()
    await page.locator('specbook-panel .response .state-badge').first().waitFor({ timeout: 30_000 })
    const keys = await page.evaluate(() => [
      ...Object.keys(localStorage),
      ...Object.keys(sessionStorage),
    ])
    expect(keys.filter((k) => k.startsWith('specbook'))).toEqual([])
    await page.close()
  })

  it('is a small download until the button is pressed', async () => {
    const files = await readdir(join(dist, 'assets')).catch(() => [] as string[])
    expect(files.length).toBeGreaterThan(0)
    const entry = await stat(join(dist, 'specbook.js'))
    // the script on the page is a few KB; the panel, the editor and the runner come on the first click
    expect(entry.size).toBeLessThan(20 * 1024)
  })
})
