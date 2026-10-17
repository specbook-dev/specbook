import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The service worker that is the demo API, in a real browser: it takes over a page on the first visit with no reload,
 * keeps what was added across page loads and across the browser stopping it, honors chaos and reset, and a page that
 * cannot use it is told so.
 */

const root = join(import.meta.dirname, '..')
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">import * as demo from '/client.js'; window.demo = demo</script></body></html>`

let dir: string
let server: Server
let origin: string
let browser: Browser

const bundle = (entry: string, out: string, format: 'iife' | 'esm') =>
  build({
    entryPoints: [join(root, entry)],
    outfile: join(dir, out),
    bundle: true,
    format,
    target: 'es2022',
    platform: 'browser',
    logLevel: 'silent',
  })

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sb-sw-'))
  await bundle('server/sw.ts', 'sw.js', 'iife')
  await bundle('server/client.ts', 'client.js', 'esm')
  // a worker that installs but never takes the page over: what a hard reload looks like to the page
  await writeFile(join(dir, 'sw-lazy.js'), "self.addEventListener('fetch', () => {})")
  await writeFile(join(dir, 'index.html'), PAGE)
  server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    // anything under /api that reaches the network, not the worker, is a failure of the test
    if (path.startsWith('/api/')) {
      res.statusCode = 599
      res.end('reached the network')
      return
    }
    const file = path === '/' ? 'index.html' : path.slice(1)
    try {
      const body = await readFile(join(dir, file))
      res.setHeader('content-type', file.endsWith('.html') ? 'text/html' : 'text/javascript')
      res.setHeader('cache-control', 'no-cache')
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
  await rm(dir, { recursive: true, force: true })
})

/** A fresh browser profile: no worker from an earlier test. */
async function visit(options: { block?: boolean } = {}) {
  const context = await browser.newContext(options.block ? { serviceWorkers: 'block' } : {})
  const page = await context.newPage()
  await page.goto(`${origin}/`)
  await page.waitForFunction(() => 'demo' in window)
  return { context, page }
}

declare global {
  interface Window {
    demo: typeof import('./client')
    heard: string[]
  }
}

const status = (page: Page, options = '') =>
  page.evaluate(async (o) => window.demo.demoReady(JSON.parse(o)), options || '{}')

const call = (page: Page, path: string, init?: RequestInit) =>
  page.evaluate(
    async ([p, i]) => {
      const res = await fetch(p as string, i as RequestInit | undefined)
      return { status: res.status, body: await res.json().catch(() => undefined) }
    },
    [path, init ?? null] as const,
  )

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

async function stopWorker(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('ServiceWorker.enable')
  await cdp.send('ServiceWorker.stopAllWorkers')
}

describe('the demo API as a service worker', () => {
  it('takes over a page on the first visit, with no reload, and answers /api itself', async () => {
    const { context, page } = await visit()
    expect(await status(page)).toBe('ready')
    const pets = await call(page, '/api/petstore/pet/findByStatus?status=available')
    expect(pets.status).toBe(200)
    expect((pets.body as { name: string }[]).map((p) => p.name)).toContain('Rex')
    await context.close()
  })

  it('keeps what was added across page loads and across the browser stopping the worker', async () => {
    const { context, page } = await visit()
    await status(page)
    expect(
      (await call(page, '/api/petstore/pet', post({ id: 900, name: 'Kept', photoUrls: [] })))
        .status,
    ).toBe(200)

    await page.reload()
    await page.waitForFunction(() => 'demo' in window)
    expect(await status(page)).toBe('ready')
    expect((await call(page, '/api/petstore/pet/900')).body).toMatchObject({ name: 'Kept' })

    // the browser stops the worker whenever it likes, taking its memory: the next call starts it from what was saved
    await stopWorker(context, page)
    expect((await call(page, '/api/petstore/pet/900')).body).toMatchObject({ name: 'Kept' })
    await context.close()
  })

  it('honors chaos and reset, and every other page hears about it', async () => {
    const { context, page } = await visit()
    await status(page)
    const other = await context.newPage()
    await other.goto(`${origin}/`)
    await other.waitForFunction(() => 'demo' in window)
    expect(await status(other)).toBe('ready')
    await other.evaluate(() => {
      window.heard = []
      window.demo.onDemoChange((what) => window.heard.push(what))
    })

    await page.evaluate(() => window.demo.setChaos({ fail: true }))
    expect((await call(page, '/api/petstore/pet/1')).status).toBe(500)
    await expect.poll(() => other.evaluate(() => window.heard)).toContain('chaos')

    await page.evaluate(() => window.demo.resetDemo())
    expect((await call(page, '/api/petstore/pet/1')).status).toBe(200)
    expect(await page.evaluate(() => window.demo.getChaos())).toMatchObject({ fail: false })
    await expect.poll(() => other.evaluate(() => window.heard)).toContain('reset')
    await context.close()
  })

  it('tells a page that cannot use service workers, instead of failing quietly', async () => {
    const { context, page } = await visit({ block: true })
    expect(await status(page, JSON.stringify({ installMs: 1500 }))).toBe('unsupported')
    await context.close()
  })

  it('tells a page the worker has not taken over, so it can offer a reload', async () => {
    const { context, page } = await visit()
    expect(await status(page, JSON.stringify({ scriptUrl: '/sw-lazy.js', waitMs: 300 }))).toBe(
      'bypassed',
    )
    await context.close()
  })
})
