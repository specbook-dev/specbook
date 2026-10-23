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
import { gzipSync } from 'node:zlib'
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

/**
 * What opening one request may cost beyond the page, gzipped, counting every file the click brings in until the page
 * is quiet again: about 103 KB for a small project and 143 KB for the example's four services (the choice of how to authenticate added about 4 KB to each, and the response tables on the Docs tab about 1 KB). About 23 KB of that is
 * the index of loaders for all 1,874 of the example's operations, which arrives just after the panel appears. A count
 * that stops when the panel appears misses it some of the time, which is why this waits. Before the lists of services
 * were fetched one at a time it was about 40 KB more for the whole API (GitHub's list alone is 29 KB).
 */
const BUDGET_KB = 105
const FULL_BUDGET_KB = 145

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

/** Serves a build under the strict policy, `host` at `/`, and answers the demo API on the page's own origin. */
async function serve(dir: string, host: string): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (req, res) => {
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
      res.end(host)
      return
    }
    try {
      const file = join(dir, url.pathname)
      if (!file.startsWith(dir)) throw new Error('outside')
      const body = await readFile(file)
      res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream')
      res.end(body)
    } catch {
      res.statusCode = 404
      res.end('not found')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sb-embed-static-'))
  await projectFiles(root)
  execFileSync('node', [cli, 'build', '--minimal', '--out', 'dist'], { cwd: root, stdio: 'pipe' })
  dist = join(root, 'dist')

  ;({ server, origin } = await serve(dist, HOST))
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

describe('the embed on the whole example API', () => {
  let fullDist: string
  let full: { server: Server; origin: string }

  beforeAll(async () => {
    // the full build: four services and about 1,800 operations, which is what a page of docs for a big API ships
    fullDist = join(root, 'full')
    execFileSync('node', [cli, 'build', '--out', fullDist], {
      cwd: example,
      stdio: 'pipe',
      timeout: 240_000,
    })
    full = await serve(
      fullDist,
      `<!doctype html><html><body>
        <p data-specbook-try="petstore/FindPetsByStatus">Find pets</p>
        <script type="module" src="/specbook.js"></script></body></html>`,
    )
  }, 300_000)

  afterAll(async () => {
    await new Promise<void>((r) => full?.server.close(() => r()))
  })

  it('opens one operation without fetching the list of any other service', async () => {
    const page = await browser.newPage()
    const got: { url: string; gzip: number }[] = []
    await page.goto(`${full.origin}/`)
    await page.locator('specbook-play').first().waitFor()
    // what the page itself still fetches is not the cost of the click: let it finish before counting
    await page.waitForLoadState('networkidle')
    page.on('response', async (r) => {
      const url = new URL(r.url())
      if (url.origin !== full.origin || !/\.(js|json|css)$/.test(url.pathname)) return
      got.push({
        url: url.pathname,
        gzip: gzipSync(await r.body().catch(() => Buffer.alloc(0))).length,
      })
    })
    await page.locator('specbook-play').first().locator('button').click()
    await page.locator('specbook-panel .request-panel .rq-bar').waitFor({ timeout: 60_000 })
    // the panel's last files arrive just after it appears: count them too, or the total depends on a race
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1_000)
    await page.waitForLoadState('networkidle')
    const total = got.reduce((n, f) => n + f.gzip, 0)
    console.log(
      `first click, whole API: ${got.length} files, ${(total / 1024).toFixed(1)} KB gzip\n${got.map((f) => `  ${f.url} ${f.gzip}`).join('\n')}`,
    )
    const names = got.map((f) => f.url)
    expect(names.some((n) => /manifest-petstore/.test(n))).toBe(true)
    // the lists of the other services stay on the server, and so does the all-services chunk the app uses
    expect(names.filter((n) => /manifest-(stripe|github|countries)|\/manifests-/.test(n))).toEqual(
      [],
    )
    expect(total).toBeLessThan(FULL_BUDGET_KB * 1024)
    await page.close()
  })

  it('still starts the whole app with every service in its catalog', async () => {
    const page = await browser.newPage()
    await page.goto(`${full.origin}/index.html`)
    await page.locator('.group-head').first().waitFor({ timeout: 60_000 })
    // the app reads every service's list as it starts: an app that started before they were there says "0 APIs"
    const text = await page.locator('body').innerText()
    expect(text).not.toMatch(/\b0 APIs/)
    // All, then one tab for each of the four services
    expect(await page.locator('.pill').count()).toBe(5)
    for (const service of ['countries', 'github', 'petstore', 'stripe'])
      expect(text).toContain(service)
    await page.close()
  })
})

describe('the embed on a page with a strict policy', () => {
  /**
   * A page long enough to scroll, scrolled so the trigger is still on screen (a click would otherwise scroll it into
   * view first), with something centred in it that would show the page shifting sideways.
   */
  const tall = (page: Page) =>
    page.evaluate(() => {
      const above = document.createElement('div')
      above.style.height = '600px'
      const below = document.createElement('div')
      below.style.height = '4000px'
      const centred = document.createElement('div')
      centred.id = 'centred'
      centred.style.cssText = 'width:200px;height:20px;margin:0 auto'
      document.body.prepend(above)
      document.body.append(centred, below)
      scrollTo(0, 500)
    })

  it('keeps the page from scrolling behind the open panel, and lets it scroll again once closed', async () => {
    const { page } = await open()
    await tall(page)
    const y = () => page.evaluate(() => Math.round(scrollY))
    await page.locator('specbook-play').first().locator('button').click()
    await page.locator('specbook-panel .panel').waitFor()
    const box = (await page.locator('specbook-panel .panel').boundingBox()) as {
      x: number
      y: number
    }
    // over the backdrop, and over the header of the panel: neither is a scroller, so both pass a wheel to the page
    for (const [x, at] of [
      [5, 300],
      [box.x + 60, box.y + 20],
    ]) {
      await page.mouse.move(x, at)
      await page.mouse.wheel(0, 150)
      await page.waitForTimeout(200)
      expect(await y(), `a wheel at ${x},${at} moved the page`).toBe(500)
    }
    await page.keyboard.press('Escape')
    await page.locator('specbook-panel .panel').waitFor({ state: 'detached' })
    await page.mouse.move(5, 300)
    await page.mouse.wheel(0, 150)
    await expect.poll(y).toBeGreaterThan(500)
    await page.close()
  })

  it('keeps a finger from scrolling the page behind the sheet on a phone', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    })
    try {
      const page = await context.newPage()
      await page.goto(`${origin}/`)
      await tall(page)
      await page.locator('specbook-play').first().locator('button').tap()
      await page.locator('specbook-panel .panel').waitFor()
      const box = (await page.locator('specbook-panel .panel').boundingBox()) as {
        y: number
      }
      // the sheet leaves a strip of the page uncovered above it, and its header and handle are not scrollers
      expect(box.y, 'a strip of backdrop shows above the sheet').toBeGreaterThan(20)
      const cdp = await context.newCDPSession(page)
      const y = () => page.evaluate(() => Math.round(scrollY))
      for (const [where, at] of [
        ['the backdrop above the sheet', box.y / 2],
        ['the handle of the sheet', box.y + 8],
        ['the header of the sheet', box.y + 40],
      ] as const) {
        await cdp.send('Input.synthesizeScrollGesture', {
          x: 195,
          y: at,
          yDistance: -150,
          gestureSourceType: 'touch',
          speed: 800,
        })
        await page.waitForTimeout(300)
        expect(await y(), `a finger on ${where} moved the page`).toBe(500)
      }
    } finally {
      await context.close()
    }
  })

  it('does not shift a page that has a scrollbar when the panel opens or closes', async () => {
    // Playwright hides scrollbars by default, and a page with none cannot shift
    const classic = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] })
    try {
      const page = await classic.newPage()
      await page.goto(`${origin}/`)
      await tall(page)
      const edge = () =>
        page.evaluate(() => document.getElementById('centred')?.getBoundingClientRect().left)
      const bar = await page.evaluate(() => innerWidth - document.documentElement.clientWidth)
      expect(bar, 'this browser draws a scrollbar').toBeGreaterThan(0)
      const before = await edge()
      await page.locator('specbook-play').first().locator('button').click()
      await page.locator('specbook-panel .panel').waitFor()
      expect(await edge()).toBe(before)
      await page.keyboard.press('Escape')
      await page.locator('specbook-panel .panel').waitFor({ state: 'detached' })
      expect(await edge()).toBe(before)
      expect(await page.evaluate(() => document.documentElement.getAttribute('style'))).toBeNull()
    } finally {
      await classic.close()
    }
  })

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

  it('downloads little to open one request, and none of another service’s list', async () => {
    const { page } = await open()
    const got: { url: string; gzip: number }[] = []
    // what the page has fetched before the click is the page; what comes after is the cost of opening one request
    await page.locator('specbook-play').first().waitFor()
    // what the page itself still fetches is not the cost of the click: let it finish before counting
    await page.waitForLoadState('networkidle')
    page.on('response', async (r) => {
      const url = new URL(r.url())
      if (url.origin !== origin || !/\.(js|json|css)$/.test(url.pathname)) return
      got.push({
        url: url.pathname,
        gzip: gzipSync(await r.body().catch(() => Buffer.alloc(0))).length,
      })
    })
    await page.locator('specbook-play').first().locator('button').click()
    await page.locator('specbook-panel .request-panel .rq-bar').waitFor({ timeout: 30_000 })
    // the panel's last files arrive just after it appears: count them too, or the total depends on a race
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1_000)
    await page.waitForLoadState('networkidle')
    const total = got.reduce((n, f) => n + f.gzip, 0)
    console.log(
      `first click: ${got.length} files, ${(total / 1024).toFixed(1)} KB gzip\n${got.map((f) => `  ${f.url} ${f.gzip}`).join('\n')}`,
    )
    expect(total).toBeLessThan(BUDGET_KB * 1024)
    await page.close()
  })

  it('still starts the whole app, with its manifests filled in before it reads them', async () => {
    const page = await browser.newPage()
    const problems: string[] = []
    page.on('pageerror', (e) => problems.push(e.message))
    await page.goto(`${origin}/index.html`)
    await page.locator('.op-row, .flow-row, .req-row').first().waitFor({ timeout: 30_000 })
    expect(problems).toEqual([])
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
