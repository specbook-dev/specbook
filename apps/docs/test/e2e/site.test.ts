import { readFile, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, resolve } from 'node:path'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The built site, served the way Cloudflare Pages serves it: `_headers` applied (so the real Content-Security-Policy is in
 * force), `_redirects` ignored, a missing page answered by `404.html`. Run with `pnpm test:site` after `pnpm build:site`.
 */

const dist = resolve(import.meta.dirname, '../../dist')
const PAGES = ['/', '/develop/', '/document/', '/test/', '/monitor/', '/reference/embed/']
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
}

interface Rule {
  pattern: RegExp
  headers: [string, string][]
  detach: string[]
}

/** The subset of the `_headers` format the site uses: a path with `*` splats, indented `Name: value`, and `! Name` to detach. */
function parseHeaders(text: string): Rule[] {
  const rules: Rule[] = []
  let rule: Rule | undefined
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (!/^\s/.test(line)) {
      const re = line
        .trim()
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
      rule = { pattern: new RegExp(`^${re}$`), headers: [], detach: [] }
      rules.push(rule)
    } else if (rule) {
      const t = line.trim()
      if (t.startsWith('!')) rule.detach.push(t.slice(1).trim().toLowerCase())
      else {
        const i = t.indexOf(':')
        rule.headers.push([t.slice(0, i).trim(), t.slice(i + 1).trim()])
      }
    }
  }
  return rules
}

function headersFor(rules: Rule[], path: string) {
  const out = new Map<string, string>()
  for (const r of rules) {
    if (!r.pattern.test(path)) continue
    for (const d of r.detach) out.delete(d)
    for (const [k, v] of r.headers)
      out.set(k.toLowerCase(), out.has(k.toLowerCase()) ? `${out.get(k.toLowerCase())}, ${v}` : v)
  }
  return out
}

async function find(path: string): Promise<{ file: string; status: number } | undefined> {
  const clean = normalize(decodeURIComponent(path.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  for (const candidate of [join(dist, clean), join(dist, clean, 'index.html')]) {
    const s = await stat(candidate).catch(() => undefined)
    if (s?.isFile()) return { file: candidate, status: 200 }
  }
  return undefined
}

let server: Server
let origin: string
let browser: Browser

beforeAll(async () => {
  const rules = parseHeaders(await readFile(join(dist, '_headers'), 'utf8'))
  server = createServer(async (req, res) => {
    const path = req.url ?? '/'
    let hit = await find(path)
    let status = 200
    if (!hit) {
      hit = { file: join(dist, '404.html'), status: 404 }
      status = 404
    }
    const h = headersFor(rules, path.split('?')[0])
    for (const [k, v] of h) res.setHeader(k, v)
    // as Pages does: a Content-Type the headers file names wins over one guessed from the extension
    if (!h.has('content-type'))
      res.setHeader('content-type', types[extname(hit.file)] ?? 'application/octet-stream')
    res.statusCode = status
    res.end(await readFile(hit.file))
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  await new Promise((ok) => server?.close(ok))
})

/** Everything on a page that would be a bug: script errors, console errors, and policy violations. */
function watch(page: Page) {
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`error: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`)
  })
  return problems
}

async function open(context: BrowserContext, path: string) {
  const page = await context.newPage()
  const problems = watch(page)
  await page.addInitScript(() => {
    ;(window as unknown as { __csp: string[] }).__csp = []
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    )
  })
  await page.goto(origin + path)
  return { page, problems }
}

/** What the page found out about the demo API: ready, or that this browser will not have its service worker. */
const demoState = (page: Page) => () =>
  page.evaluate(() => document.documentElement.dataset.demo as string | undefined)

const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)

describe('the built site', () => {
  it('every page loads without errors or policy violations, and fits a phone', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 } })
    for (const path of PAGES) {
      const { page, problems } = await open(context, path)
      await page.waitForLoadState('networkidle')
      expect(await violations(page), path).toEqual([])
      expect(problems, path).toEqual([])
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(wide, `${path} scrolls sideways`).toBeLessThanOrEqual(0)
      await page.close()
    }
    await context.close()
  })

  it('every page can be shared: a title, a description and a card image of the right size, on every kind of page', async () => {
    const context = await browser.newContext()
    for (const path of ['/', '/develop/', '/document/', '/test/', '/monitor/', '/reference/cli/']) {
      const page = await context.newPage()
      await page.goto(origin + path)
      const tag = (name: string) =>
        page
          .locator(`meta[property="${name}"], meta[name="${name}"]`)
          .first()
          .getAttribute('content')
      const where = (what: string) => `${path} ${what}`
      expect(await tag('og:title'), where('og:title')).toBeTruthy()
      expect(await tag('og:description'), where('og:description')).toBeTruthy()
      // a link in a post is fetched from outside, so the picture's address names the site, not this test server
      expect(await tag('og:image'), where('og:image')).toMatch(
        /^https:\/\/docs\.specbook\.dev\/og\/[\w-]+\.png$/,
      )
      expect(await tag('og:image:width'), where('width')).toBe('1200')
      expect(await tag('og:image:height'), where('height')).toBe('630')
      expect((await tag('og:image:alt')) ?? '', where('alt')).not.toBe('')
      expect(await tag('twitter:card'), where('twitter:card')).toBe('summary_large_image')
      await page.close()
    }
    await context.close()
  })

  it('on a phone every link in the header is reachable: the five links have a row of their own', async () => {
    for (const width of [320, 360, 390, 430]) {
      const context = await browser.newContext({ viewport: { width, height: 700 } })
      const page = await context.newPage()
      await page.goto(`${origin}/`)
      const m = await page.evaluate(() => {
        const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect()
        const nav = document.querySelector('.nav') as HTMLElement
        const links = [...nav.querySelectorAll('a')].map((a) => a.getBoundingClientRect())
        return {
          page: document.documentElement.scrollWidth,
          brandBottom: box('.brand')?.bottom ?? 0,
          navTop: nav.getBoundingClientRect().top,
          count: links.length,
          // how far the last link reaches past the viewport, if the row is not scrolled
          overshoot: Math.max(...links.map((r) => r.right)) - innerWidth,
          scrolls: nav.scrollWidth > nav.clientWidth,
          header: box('.top')?.height ?? 0,
        }
      })
      expect(m.page, `${width}: the page does not scroll sideways`).toBeLessThanOrEqual(width)
      expect(m.navTop, `${width}: the links are on a row below the logo`).toBeGreaterThanOrEqual(
        m.brandBottom - 1,
      )
      expect(m.count).toBe(5)
      // wide enough for all five: none is cut off. Narrower: the row scrolls, and the first links show
      if (width >= 375) expect(m.overshoot, `${width}: all five fit`).toBeLessThanOrEqual(0)
      else expect(m.scrolls, `${width}: the row scrolls`).toBe(true)
      expect(m.header, `${width}: the header stays slim`).toBeLessThan(110)
      await context.close()
    }
  })

  it('has a search index covering the pages', async () => {
    const entry = JSON.parse(await readFile(join(dist, 'pagefind/pagefind-entry.json'), 'utf8'))
    const pages = Object.values<{ page_count: number }>(entry.languages).reduce(
      (n, l) => n + l.page_count,
      0,
    )
    expect(pages).toBeGreaterThanOrEqual(PAGES.length)
  })

  it('sends a visitor with a spec of their own to the viewer, in a new window, at any phone width', async () => {
    for (const width of [320, 390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 800 } })
      const { page } = await open(context, '/')
      const link = page.locator('.hero-actions a', { hasText: 'Open your own spec' })
      expect(await link.getAttribute('href'), `${width}`).toBe('https://ui.specbook.dev')
      expect(await link.getAttribute('target')).toBe('_blank')
      expect(await link.getAttribute('rel')).toContain('noopener')
      expect(await link.locator('.sr-only').textContent()).toContain('opens in a new window')
      // both hero buttons are on screen, and the page does not scroll sideways
      const box = await link.boundingBox()
      expect(box && box.x >= 0 && box.x + box.width <= width, `${width}: the button fits`).toBe(
        true,
      )
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true)
      expect(await page.locator('.hero-actions a').count()).toBe(2)
      await context.close()
    }
  })

  it('serves llms.txt as plain text, the guide an agent reads first', async () => {
    const res = await fetch(`${origin}/llms.txt`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    const text = await res.text()
    expect(text.startsWith('# Specbook')).toBe(true)
    expect(text).toContain('## Write isomorphic code')
  })

  it('answers a missing page with the 404 page', async () => {
    const context = await browser.newContext()
    const { page } = await open(context, '/no-such-page/')
    await expect.poll(() => page.title()).toMatch(/not found|404/i)
    await context.close()
  })

  it('the service worker takes control, and a request in the popover on the Document page answers from the spec', async () => {
    const context = await browser.newContext()
    const { page, problems } = await open(context, '/document/')
    await expect.poll(demoState(page), { timeout: 30_000 }).toBe('ready')

    // a plain element marked to run gets a Play button beside it
    await page
      .locator('[data-specbook-try="requests/petstore/get-pet.req.ts"] specbook-play button')
      .click()
    await page.locator('specbook-panel button[aria-label="Send"]').click()
    await expect
      .poll(() => page.locator('specbook-panel .response .state-badge').first().textContent(), {
        timeout: 30_000,
      })
      .toMatch(/200/)
    expect(await violations(page)).toEqual([])
    expect(problems).toEqual([])
    await context.close()
  })

  it('a flow runs with its defaults', async () => {
    const context = await browser.newContext()
    const { page } = await open(context, '/document/')
    await expect.poll(demoState(page), { timeout: 30_000 }).toBe('ready')
    await page.locator('button[data-specbook-flow="new-pet"]').click()
    await page.getByRole('button', { name: 'Run with defaults' }).click()
    await expect
      .poll(() => page.locator('specbook-panel .seq-run .badge').first().textContent(), {
        timeout: 30_000,
      })
      .toMatch(/pass/i)
    await context.close()
  })

  it('the terminal runs the demo: it passes, fails when the API is down, and calls a retried pass flaky', async () => {
    const context = await browser.newContext()
    const { page, problems } = await open(context, '/monitor/')
    await expect.poll(demoState(page), { timeout: 30_000 }).toBe('ready')
    const term = page.locator('.term-live').first()
    // the island loads when it is on screen
    await term.scrollIntoViewIfNeeded()
    const output = term.locator('.term-out')
    const run = async (label?: string) => {
      if (label) await term.getByRole('button', { name: label }).click()
      await term.getByRole('button', { name: /^Run/ }).click()
      await expect.poll(() => output.textContent(), { timeout: 30_000 }).toMatch(/exit \d/)
      return (await output.textContent()) ?? ''
    }
    const passing = await run()
    expect(passing).toContain('specbook test')
    expect(passing).toContain('✓')
    expect(passing).toMatch(/exit 0/)
    const down = await run('API down')
    expect(down).toContain('✗')
    expect(down).toMatch(/exit 1/)
    const flaky = await run('Flaky')
    expect(flaky).toMatch(/retrying/)
    expect(flaky).toMatch(/exit 0/)
    expect(await violations(page)).toEqual([])
    // the browser logs the 500s the demo API answers on purpose; anything else is a problem
    expect(problems.filter((p) => !/status of 500/.test(p))).toEqual([])
    await context.close()
  })

  it('a recording of the real tool plays on the Test page', async () => {
    const context = await browser.newContext()
    const { page, problems } = await open(context, '/test/')
    const replay = page
      .locator('section.term', { hasText: 'specbook test' })
      .filter({ has: page.getByRole('button', { name: 'Replay' }) })
      .first()
    await replay.scrollIntoViewIfNeeded()
    await expect
      .poll(() => replay.locator('.term-out').textContent(), { timeout: 20_000 })
      .toMatch(/exit [01]/)
    expect(await violations(page)).toEqual([])
    expect(problems).toEqual([])
    await context.close()
  })

  it("the landing page runs a request on mock data, calls nothing, and shows the request's checks", async () => {
    const context = await browser.newContext()
    const called: string[] = []
    context.on('request', (r) => {
      if (r.url().includes('swagger.io')) called.push(r.url())
    })
    const { page, problems } = await open(context, '/')
    await page.locator('button[data-specbook-try="requests/petstore/get-pet.req.ts"]').click()
    await page.locator('specbook-panel button[aria-label="Send"]').click()
    await expect
      .poll(() => page.locator('specbook-panel .response .state-badge').first().textContent(), {
        timeout: 30_000,
      })
      .toMatch(/200/)
    expect(called).toEqual([])
    // the request's own checks are shown, not just the response
    const panel = await page.evaluate(
      () =>
        document.querySelector('specbook-panel')?.shadowRoot?.querySelector('.sb-root')
          ?.textContent,
    )
    expect(panel).toMatch(/Checks\s*2/)
    // `petId` comes from the request's own init, so nothing is asked of the visitor, and mock needs no key
    expect(panel).not.toMatch(/Needs a value/)
    expect(await page.locator('specbook-panel .needs-vars').count()).toBe(0)
    expect(await violations(page)).toEqual([])
    expect(problems).toEqual([])
    await context.close()
  })

  it('the landing flow passes on mock data with no network and no key', async () => {
    const context = await browser.newContext()
    const called: string[] = []
    context.on('request', (r) => {
      if (r.url().includes('swagger.io')) called.push(r.url())
    })
    const { page } = await open(context, '/')
    await page.locator('button[data-specbook-flow="adopt-pet"]').click()
    await page.getByRole('button', { name: 'Run with defaults' }).click()
    await expect
      .poll(() => page.locator('specbook-panel .seq-run .badge').first().textContent(), {
        timeout: 30_000,
      })
      .toMatch(/Passed/)
    expect(called).toEqual([])
    await context.close()
  })

  it('switching the landing flow to live asks for the Petstore key, and a failing live server ends the run with its answer shown', async () => {
    const context = await browser.newContext()
    const orders: string[] = []
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
    await context.route('https://petstore3.swagger.io/**', (route) => {
      const req = route.request()
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      if (req.url().includes('/pet/findByStatus'))
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: cors,
          body: JSON.stringify([{ id: 7, name: 'Rex', photoUrls: [], status: 'available' }]),
        })
      orders.push(req.postData() ?? '')
      return route.fulfill({
        status: 500,
        contentType: 'text/html',
        headers: cors,
        body: '<h1>Internal Server Error</h1>',
      })
    })
    const { page } = await open(context, '/')
    await page.locator('button[data-specbook-flow="adopt-pet"]').click()
    await page
      .locator('specbook-panel select[aria-label="Environment"]:visible')
      .selectOption('live')
    // live is the real API: the secured step shows the key it will send, and nothing is sent until it has one
    const bar = page.locator('specbook-panel .needs-vars')
    await expect.poll(() => bar.textContent(), { timeout: 10_000 }).toMatch(/PETSTORE_API_KEY/)
    await bar.locator('input').fill('any-value')
    // committed when the field is left, as a person does by tabbing away
    await bar.locator('input').press('Tab')
    await page.getByRole('button', { name: 'Run with defaults' }).click()
    // the run ends: the button is a Run button again, the summary says it failed, and the failing step can be opened
    await expect
      .poll(() => page.locator('specbook-panel .seq-run .badge').first().textContent(), {
        timeout: 30_000,
      })
      .toMatch(/Failed|Error/)
    expect(
      await page.locator('specbook-panel .seq-run .btn.primary').first().textContent(),
    ).not.toContain('Running')
    expect(await page.locator('specbook-panel .panel-error').count()).toBe(0)
    // the default pet is the first one found, not a pet numbered 0
    expect(JSON.parse(orders[0] ?? '{}').petId).toBe(7)
    await page.locator('specbook-panel .jhead', { hasText: 'Place order' }).click()
    await expect
      .poll(() => page.locator('specbook-panel .seq-right').first().textContent(), {
        timeout: 10_000,
      })
      .toMatch(/500/)
    await context.close()
  })

  it('Document: the docs tab of the popover shows the notes written beside the operation', async () => {
    const context = await browser.newContext()
    const { page, problems } = await open(context, '/document/')
    await expect.poll(demoState(page), { timeout: 30_000 }).toBe('ready')
    await page.getByRole('button', { name: 'Open the docs for Get a pet by id' }).click()
    await page.locator('specbook-panel').getByText('Looks a pet up by its id').waitFor({
      timeout: 30_000,
    })
    expect(await violations(page)).toEqual([])
    expect(problems).toEqual([])
    await context.close()
  })

  it('the portals list their APIs and operations', async () => {
    // a portal whose manifests did not load opens with "0 APIs · 0 operations"
    const context = await browser.newContext()
    for (const path of ['/qa/', '/demo/']) {
      const { page } = await open(context, path)
      await page.locator('.group-head').first().waitFor({ timeout: 60_000 })
      const text = await page.locator('body').innerText()
      expect(text, path).not.toMatch(/\b0 APIs/)
      expect(text, path).not.toMatch(/\b0 operations/)
      await page.close()
    }
    await context.close()
  })

  it('the landing page buttons need no service worker: they answer from the spec', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const { page } = await open(context, '/')
    await expect.poll(demoState(page), { timeout: 30_000 }).toMatch(/unsupported|bypassed/)
    for (const sel of ['button[data-specbook-try]', 'button[data-specbook-flow]']) {
      expect(await page.locator(sel).first().isDisabled(), sel).toBe(false)
      expect(await page.locator(sel).first().getAttribute('title'), sel).toBeNull()
    }
    await context.close()
  })
})
