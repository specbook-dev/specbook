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
const PAGES = [
  '/',
  '/discover/',
  '/develop/',
  '/document/',
  '/test/',
  '/monitor/',
  '/reference/embed/',
]
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

  it('has a search index covering the pages', async () => {
    const entry = JSON.parse(await readFile(join(dist, 'pagefind/pagefind-entry.json'), 'utf8'))
    const pages = Object.values<{ page_count: number }>(entry.languages).reduce(
      (n, l) => n + l.page_count,
      0,
    )
    expect(pages).toBeGreaterThanOrEqual(PAGES.length)
  })

  it('answers a missing page with the 404 page', async () => {
    const context = await browser.newContext()
    const { page } = await open(context, '/no-such-page/')
    await expect.poll(() => page.title()).toMatch(/not found|404/i)
    await context.close()
  })

  it('the service worker takes control and a request in the popover runs against the demo API', async () => {
    const context = await browser.newContext()
    const { page, problems } = await open(context, '/test/')
    const chip = page.locator('[data-demo-status]').first()
    await expect.poll(() => chip.getAttribute('data-state'), { timeout: 30_000 }).toBe('ready')

    await page.locator('button[data-specbook-try="petstore/FindPetsByStatus"]').click()
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
    const { page } = await open(context, '/test/')
    await expect
      .poll(() => page.locator('[data-demo-status]').first().getAttribute('data-state'), {
        timeout: 30_000,
      })
      .toBe('ready')
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
    const { page, problems } = await open(context, '/test/')
    await expect
      .poll(() => page.locator('[data-demo-status]').first().getAttribute('data-state'), {
        timeout: 30_000,
      })
      .toBe('ready')
    const term = page.locator('.term').first()
    // the island loads when it is on screen
    await term.scrollIntoViewIfNeeded()
    const output = term.locator('.term-out')
    const run = async (label?: string) => {
      if (label) await term.getByRole('radio', { name: label }).click()
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

  it('without a service worker the page says so and the buttons are not left waiting', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const { page } = await open(context, '/test/')
    const chip = page.locator('[data-demo-status]').first()
    await expect
      .poll(() => chip.getAttribute('data-state'), { timeout: 30_000 })
      .toMatch(/unsupported|bypassed/)
    expect(await chip.textContent()).not.toMatch(/Starting/)
    await context.close()
  })
})
