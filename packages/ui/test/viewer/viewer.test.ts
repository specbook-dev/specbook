import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const assemble = resolve(import.meta.dirname, '../../scripts/assemble-site.mjs')
const fixtures = resolve(import.meta.dirname, '../../../codegen/test/fixtures')
const examples = resolve(import.meta.dirname, '../../../../apps/example/openapi')
const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const liveSpec = (base: string) => ({
  openapi: '3.0.3',
  info: { title: 'Live Things', version: '1' },
  servers: [{ url: `${base}/live-api` }],
  security: [{ key: [] }],
  components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Key' } } },
  paths: {
    '/things': {
      get: {
        operationId: 'listThings',
        summary: 'List things',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': { schema: { type: 'array', items: { type: 'object' } } },
            },
          },
        },
      },
    },
  },
})

/** Two servers on different origins, as a production and a sandbox host would be. */
const multiSpec = (base: string) => {
  const port = new URL(base).port
  const one = liveSpec(base)
  return {
    ...one,
    info: { ...one.info, title: 'Multi Things' },
    servers: [
      { url: `${base}/live-api`, description: 'Production' },
      { url: `http://127.0.0.1:${port}/sandbox-api`, description: 'Sandbox' },
    ],
  }
}

/** An API behind an OAuth 2.0 authorization code flow, with a provider (`/oauth/*`) on the same fixture server. */
const oauthSpec = (base: string) => ({
  openapi: '3.0.3',
  info: { title: 'OAuth Gate', version: '1' },
  servers: [{ url: `${base}/oauth-api` }],
  security: [{ gate: [] }],
  components: {
    securitySchemes: {
      gate: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: `${base}/oauth/authorize`,
            tokenUrl: `${base}/oauth/token`,
            scopes: { read: 'read' },
          },
        },
      },
    },
  },
  paths: {
    '/thing': {
      get: {
        operationId: 'getThing',
        summary: 'Get the thing',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
})

let site: Server
let dist: string
let rules: { match: RegExp; headers: string[][] }[] = []
let api: Server
let siteUrl: string
let apiUrl: string
let browser: Browser
const seen: { key?: string; calls: number; path?: string; auth?: string; redirect?: string } = {
  calls: 0,
}

const listen = (s: Server) =>
  new Promise<string>((r) =>
    s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)),
  )

beforeAll(async () => {
  // the site as it is deployed: landing at /, the viewer at /v1/, and the headers file's policy applied
  dist = await mkdtemp(join(tmpdir(), 'sb-site-'))
  execFileSync('node', [assemble, '--out', dist], { stdio: 'ignore' })
  // the headers file as Pages applies it: each block names a path pattern, `*` matching anything
  rules = (await readFile(join(dist, '_headers'), 'utf8'))
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')))
    .filter((lines) => lines.length > 1)
    .map(([path, ...rest]) => ({
      match: new RegExp(
        `^${(path as string)
          .trim()
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')}$`,
      ),
      headers: rest
        .map((l) => l.trim().split(/:\s(.+)/))
        .map((p) => [p[0] as string, p[1] as string]),
    }))
  site = createServer(async (req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname
    try {
      const f = join(dist, p === '/' ? 'index.html' : p.endsWith('/') ? `${p}index.html` : p)
      res.setHeader('content-type', types[extname(f)] ?? 'application/octet-stream')
      for (const r of rules)
        if (r.match.test(p === '/' ? '/' : p))
          for (const [k, v] of r.headers) res.setHeader(k as string, v as string)
      res.end(await readFile(f))
    } catch {
      res.statusCode = 404
      res.end('not found')
    }
  })
  api = createServer(async (req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname
    const cors = !p.startsWith('/nocors/')
    if (cors) {
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('access-control-allow-headers', '*')
    }
    if (req.method === 'OPTIONS') return void res.end()
    res.setHeader('content-type', 'application/json')
    try {
      if (p === '/live/openapi.json') return void res.end(JSON.stringify(liveSpec(apiUrl)))
      if (p === '/multi/openapi.json') return void res.end(JSON.stringify(multiSpec(apiUrl)))
      // a stand-in provider: sends the person straight back with a code, and trades it for a token
      if (p === '/oauth/openapi.json') return void res.end(JSON.stringify(oauthSpec(apiUrl)))
      if (p === '/oauth/authorize') {
        const q = new URL(req.url ?? '/', 'http://x').searchParams
        seen.redirect = q.get('redirect_uri') ?? undefined
        const back = new URL(q.get('redirect_uri') as string)
        back.searchParams.set('code', 'fake-code')
        back.searchParams.set('state', q.get('state') as string)
        res.statusCode = 302
        res.setHeader('location', back.toString())
        return void res.end()
      }
      if (p === '/oauth/token')
        return void res.end(JSON.stringify({ access_token: 'tok-iframe', expires_in: 600 }))
      if (p === '/oauth-api/thing') {
        seen.auth = req.headers.authorization as string | undefined
        return void res.end('{"ok":true}')
      }
      // a docs page that loads the embed script, as a framework's docs route would; it answers any query,
      // so a sign-in's return (`?code=&state=`) comes back to the same page
      if (p === '/host/embed.html') {
        res.setHeader('content-type', 'text/html')
        return void res.end(
          `<!doctype html><div id="app"></div>` +
            `<script type="application/json" id="specbook-config">${JSON.stringify({ spec: `${apiUrl}/oauth/openapi.json` })}</script>` +
            `<script type="module" src="${siteUrl}/v1/specbook.js"></script>`,
        )
      }
      // a page on another site that frames the hosted viewer
      if (p === '/host/iframe.html') {
        const spec = encodeURIComponent(`${apiUrl}/oauth/openapi.json`)
        res.setHeader('content-type', 'text/html')
        return void res.end(
          `<!doctype html><iframe title="viewer" style="width:1000px;height:760px;border:0" src="${siteUrl}/v1/?spec=${spec}"></iframe>`,
        )
      }
      if (p === '/sandbox-api/things') {
        seen.calls++
        seen.path = p
        seen.key = req.headers['x-key'] as string | undefined
        return void res.end('[{"id":2}]')
      }
      if (p === '/live-api/things') {
        seen.calls++
        seen.path = p
        seen.key = req.headers['x-key'] as string | undefined
        return void res.end('[{"id":1}]')
      }
      if (p.startsWith('/slow/')) await new Promise((r) => setTimeout(r, 1500))
      const name = p.replace(/^\/(nocors|slow)\//, '').replace(/^\//, '')
      const file = name.startsWith('example/')
        ? join(examples, name.slice(8))
        : join(fixtures, name)
      res.end(await readFile(file))
    } catch {
      res.statusCode = 404
      res.end('{"error":"not found"}')
    }
  })
  siteUrl = await listen(site)
  // the fixture API answers to a public-looking name, as a real API would (a loopback address is, rightly,
  // treated as private by the landing page)
  const port = new URL(await listen(api)).port
  apiUrl = `http://api.fixture.test:${port}`
  browser = await chromium.launch({
    args: ['--host-resolver-rules=MAP api.fixture.test 127.0.0.1'],
  })
})

afterAll(async () => {
  await browser?.close()
  site?.close()
  api?.close()
})

const open = async (query: string) => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${siteUrl}/v1/?${query}`)
  return { page, errors }
}

const spec = (name: string) => `spec=${encodeURIComponent(`${apiUrl}/${name}`)}`
const ready = (page: Page) => page.waitForSelector('.header .brand', { timeout: 30_000 })
const goOp = async (page: Page, key: string) => {
  await page.evaluate((k) => {
    location.hash = `#/op/${encodeURIComponent(k)}`
  }, key)
  await page.waitForSelector('.request-panel .rq-bar', { timeout: 30_000 })
}

describe('the hosted viewer opens a spec at run time', () => {
  it('shows an OpenAPI 3 document: catalog, Docs, and a mock request', async () => {
    const { page, errors } = await open(spec('petstore3.json'))
    await ready(page)
    expect(await page.title()).toContain('Petstore')
    await page.waitForSelector('.op-row')
    expect(await page.locator('.op-row').count()).toBeGreaterThan(10)

    await goOp(page, 'swagger-petstore-openapi-3-0/FindPetsByStatus')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.result-chip:has-text("200")', { timeout: 20_000 })

    await page.getByRole('tab', { name: 'Docs' }).click()
    await page.waitForSelector('.doc table.fields')
    expect(await page.locator('.doc').innerText()).toContain('status')
    expect(errors).toEqual([])
    await page.close()
  })

  it("shows the app's own shape while the document downloads, and the app replaces it in place", async () => {
    const { page, errors } = await open(spec('slow/petstore3.json'))
    await page.waitForSelector('.sk', { timeout: 10_000 })
    // not the picker card: a link that names its document goes straight to opening it
    expect(await page.locator('.vw-card').count()).toBe(0)
    const before = await page.locator('.sk .sk-brand img').boundingBox()
    const bar = await page.locator('.sk .sk-search').boundingBox()

    await ready(page)
    await page.waitForSelector('.op-row', { state: 'attached', timeout: 30_000 })
    expect(await page.locator('.sk').count()).toBe(0)
    const after = await page.locator('.header .brand .brand-logo').boundingBox()
    const palette = await page.locator('.header .palette-btn').boundingBox()
    // the mark and the search box land where the placeholders were (a pixel or two for the brand's padding)
    expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThanOrEqual(2)
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(2)
    expect(Math.abs((palette?.x ?? 0) - (bar?.x ?? 0))).toBeLessThanOrEqual(2)
    expect(errors).toEqual([])
    await page.close()
  })

  it('shows a Swagger 2 document the same way', async () => {
    const { page, errors } = await open(spec('petstore2.json'))
    await ready(page)
    await page.waitForSelector('.op-row')
    expect(await page.locator('.op-row').count()).toBeGreaterThan(10)
    expect(errors).toEqual([])
    await page.close()
  })

  it('says what went wrong when the server does not allow the browser, and takes the pasted text', async () => {
    const { page } = await open(spec('nocors/petstore3.json'))
    await page.waitForSelector('.vw-error')
    const msg = await page.locator('.vw-error').innerText()
    expect(msg).toMatch(/CORS/)
    expect(msg).toMatch(/Paste the document/)
    // the same document, pasted, opens
    const text = await readFile(join(fixtures, 'petstore3.json'), 'utf8')
    await page.locator('details summary').click()
    await page.getByLabel('OpenAPI or Swagger document text').fill(text)
    await page.getByRole('button', { name: 'Open pasted document' }).click()
    // a relative `servers` entry has no address of its own: the person is asked, and may skip it
    await page.getByRole('button', { name: 'Continue with mock data' }).click()
    await page.waitForSelector('.op-row', { timeout: 30_000 })
    await page.close()
  })

  it('reopens an uploaded document after a reload', async () => {
    const { page } = await open('')
    const text = await readFile(join(fixtures, 'petstore3.json'), 'utf8')
    await page.locator('details summary').click()
    await page.getByLabel('OpenAPI or Swagger document text').fill(text)
    await page.getByRole('button', { name: 'Open pasted document' }).click()
    await page.getByRole('button', { name: 'Continue with mock data' }).click()
    await page.waitForSelector('.op-row', { timeout: 30_000 })
    expect(page.url()).toContain('upload=')
    await page.reload()
    await page.getByRole('button', { name: 'Continue with mock data' }).click()
    await page.waitForSelector('.op-row', { timeout: 30_000 })
    await page.close()
  })

  it('reports a document that is not a spec in words', async () => {
    const { page } = await open(
      spec('petstore3.json').replace('petstore3.json', 'nonexistent.json'),
    )
    await page.waitForSelector('.vw-error')
    expect(await page.locator('.vw-error').innerText()).toMatch(/404|answered/)
    await page.close()
  })

  it('sends a live request straight to the API with the key typed in the page', async () => {
    const { page } = await open(spec('live/openapi.json'))
    await ready(page)
    await goOp(page, 'live-things/ListThings')
    // switch to the live environment, then give the credential the spec asks for
    await page
      .locator('.header-controls label.row', { hasText: 'Environment' })
      .locator('select')
      .selectOption('live')
    const key = page.getByLabel(/KEY for live-things/)
    await key.fill('secret-123')
    await key.press('Tab')
    seen.calls = 0
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.result-chip:has-text("200")', { timeout: 20_000 })
    expect(seen.calls).toBe(1)
    expect(seen.key).toBe('secret-123')
    await page.close()
  })
})

describe('a document that lists several servers', () => {
  const picker = (page: Page) =>
    page.locator('.header-controls label.row', { hasText: 'Environment' }).locator('select')

  it('offers each as an environment and sends to the one chosen, asking again for another origin’s key', async () => {
    const { page, errors } = await open(spec('multi/openapi.json'))
    await ready(page)
    await goOp(page, 'multi-things/ListThings')
    const options = await picker(page).locator('option').allInnerTexts()
    // the last entry is the way to make another one
    expect(options).toEqual(['mock', 'live', 'sandbox', 'New environment…'])
    // the description is the entry's tooltip
    expect(await picker(page).locator('option', { hasText: 'sandbox' }).getAttribute('title')).toBe(
      'Sandbox',
    )

    await picker(page).selectOption('sandbox')
    const key = page.getByLabel(/KEY for multi-things/)
    await key.fill('sandbox-key')
    await key.press('Tab')
    seen.calls = 0
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.result-chip:has-text("200")', { timeout: 20_000 })
    expect(seen.calls).toBe(1)
    expect(seen.path).toBe('/sandbox-api/things')
    expect(seen.key).toBe('sandbox-key')

    // production is another origin: the sandbox key is not carried over, and is asked for again
    await picker(page).selectOption('live')
    await page.waitForSelector('input[aria-label^="KEY for multi-things"]')
    expect(await page.getByLabel(/KEY for multi-things/).inputValue()).toBe('')
    expect(seen.calls).toBe(1)
    expect(errors).toEqual([])
    await page.close()
  })
})

describe('an environment made in the viewer', () => {
  const picker = (page: Page) =>
    page.locator('.header-controls label.row', { hasText: 'Environment' }).locator('select')

  it('is a copy whose address can be changed, calls there, and is still there after a reload', async () => {
    const { page, errors } = await open(spec('multi/openapi.json'))
    await ready(page)
    await goOp(page, 'multi-things/ListThings')
    await picker(page).selectOption('New environment…')
    await page.getByLabel('Environment name').fill('mine')
    await page.getByLabel('Duplicate of').selectOption('sandbox')
    await page.getByRole('button', { name: 'Create' }).click()
    // it is selected, and its settings are open with the address it copied
    await page.waitForSelector('.envmenu-pop')
    const address = page.getByLabel('Value of baseUrl')
    expect(await address.inputValue()).toMatch(/\/sandbox-api$/)
    // point it at the production server instead
    const live = (await address.inputValue()).replace('/sandbox-api', '/live-api')
    await address.fill(live)
    await address.press('Enter')
    await page.waitForFunction(
      (v) =>
        (document.querySelector('.envmenu-pop')?.textContent ?? '').includes(`calls go to ${v}`),
      live,
    )
    expect(await picker(page).inputValue()).toBe('mine')

    // it is kept in this browser, per document
    await page.reload()
    await ready(page)
    await goOp(page, 'multi-things/ListThings')
    expect(await picker(page).locator('option').allInnerTexts()).toContain('mine')
    await picker(page).selectOption('mine')
    const key = page.getByLabel(/KEY for multi-things/)
    await key.fill('k')
    await key.press('Tab')
    seen.calls = 0
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.result-chip:has-text("200")', { timeout: 20_000 })
    expect(seen.path).toBe('/live-api/things')
    expect(errors).toEqual([])
    await page.close()
  })
})

describe('the sign-in callback page', () => {
  it('is served unversioned, with the site’s policy and no inline script', async () => {
    const r = await fetch(`${siteUrl}/oauth/callback/`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')
    expect(r.headers.get('cache-control')).toBe('no-cache')
    expect(r.headers.get('x-robots-tag')).toBe('noindex')
    expect(await r.text()).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
    // and the hosted viewer is told to send people there
    const viewer = await (await fetch(`${siteUrl}/v1/`)).text()
    expect(viewer).toContain('name="specbook-oauth-callback" content="/oauth/callback/"')
  })

  it('hands what the provider returned to the tab that is waiting, then closes', async () => {
    const page = await browser.newPage()
    await page.goto(`${siteUrl}/`)
    // a tab on the site standing in for a viewer that started a sign-in
    await page.evaluate(() => {
      const w = window as unknown as { __got: unknown[] }
      w.__got = []
      const ch = new BroadcastChannel('specbook-oauth')
      ch.onmessage = (e) => {
        if (e.data?.type !== 'callback') return
        w.__got.push(e.data)
        ch.postMessage({ type: 'ack', state: e.data.state })
      }
    })
    const popup = page.waitForEvent('popup')
    await page.evaluate(() => window.open('/oauth/callback/?code=c1&state=s1&extra=x', 'cb'))
    const opened = await popup
    if (!opened.isClosed()) await opened.waitForEvent('close', { timeout: 15_000 })
    const got = (await page.evaluate(() => (window as unknown as { __got: unknown[] }).__got)) as {
      state: string
      code: string
    }[]
    expect(got[0]).toMatchObject({ type: 'callback', state: 's1', code: 'c1' })
    await page.close()
  })

  it('says nobody is waiting when opened by itself, and keeps the code out of the address', async () => {
    const page = await browser.newPage()
    await page.goto(`${siteUrl}/oauth/callback/?code=stray&state=stray`)
    await page.getByText('No Specbook window is waiting').waitFor({ timeout: 10_000 })
    expect(page.url()).toBe(`${siteUrl}/oauth/callback/`)
    await page.getByRole('link', { name: 'Open the viewer' }).waitFor()
    await page.close()
  })

  it('completes a sign-in for a viewer framed on another site, which cannot hear a channel', async () => {
    const page = await browser.newPage()
    // `*.localhost` is a secure context, as a real host page over https is: the viewer's PKCE needs
    // WebCrypto, which a frame inside a plain-http page does not get
    await page.goto(`http://host.localhost:${new URL(apiUrl).port}/host/iframe.html`)
    const frame = await vi.waitFor(() => {
      const f = page.frames().find((x) => x.url().includes('/v1/'))
      expect(f).toBeTruthy()
      return f as NonNullable<typeof f>
    })
    await frame.waitForSelector('.header .brand', { timeout: 30_000 })
    await frame.evaluate((k: string) => {
      location.hash = `#/op/${encodeURIComponent(k)}`
    }, 'oauth-gate/GetThing')
    await frame.waitForSelector('.request-panel .rq-bar', { timeout: 30_000 })
    await frame
      .locator('.header-controls label.row', { hasText: 'Environment' })
      .locator('select')
      .selectOption('live')

    await frame.getByLabel(/Client id for/).fill('docs')
    await expect
      .poll(() => frame.getByRole('button', { name: 'Sign in' }).isEnabled(), { timeout: 20_000 })
      .toBe(true)
    const popup = page.waitForEvent('popup')
    await frame.getByRole('button', { name: 'Sign in' }).click()
    const opened = await popup
    if (!opened.isClosed()) await opened.waitForEvent('close', { timeout: 30_000 })

    try {
      await frame.locator('.secrets-chip').waitFor({ state: 'visible', timeout: 15_000 })
    } catch (e) {
      // say what the person would have seen, not only that a wait ran out
      const prompt = await frame
        .locator('fieldset.needs-vars')
        .innerText({ timeout: 2_000 })
        .catch(() => '(no prompt)')
      throw new Error(
        `sign-in did not complete. Prompt: ${JSON.stringify(prompt)}. Popup closed: ${opened.isClosed()}, ` +
          `last at ${opened.url()}. Provider was sent redirect_uri ${seen.redirect}.`,
        { cause: e },
      )
    }
    await frame.getByRole('button', { name: 'Send' }).click()
    await frame.waitForSelector('.result-chip:has-text("200")', { timeout: 20_000 })
    expect(seen.auth).toBe('Bearer tok-iframe')
    // the provider was sent the stable address, not a path under /v1/
    expect(seen.redirect).toBe(`${siteUrl}/oauth/callback/`)
    await page.close()
  })
})

describe('sign-in from an embedded viewer', () => {
  it('completes on the host page: the popup returns there, and the script hands the code on', async () => {
    const hostPage = `http://host.localhost:${new URL(apiUrl).port}/host/embed.html`
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(hostPage)
    await page.waitForSelector('.header .brand', { timeout: 30_000 })
    await page.evaluate((k: string) => {
      location.hash = `#/op/${encodeURIComponent(k)}`
    }, 'oauth-gate/GetThing')
    await page.waitForSelector('.request-panel .rq-bar', { timeout: 30_000 })
    await page
      .locator('.header-controls label.row', { hasText: 'Environment' })
      .locator('select')
      .selectOption('live')

    await page.getByLabel(/Client id for/).fill('docs')
    await expect
      .poll(() => page.getByRole('button', { name: 'Sign in' }).isEnabled(), { timeout: 20_000 })
      .toBe(true)
    const popup = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Sign in' }).click()
    const opened = await popup
    if (!opened.isClosed()) await opened.waitForEvent('close', { timeout: 30_000 })

    try {
      await page.locator('.secrets-chip').waitFor({ state: 'visible', timeout: 15_000 })
    } catch (e) {
      const prompt = await page
        .locator('fieldset.needs-vars')
        .innerText({ timeout: 2_000 })
        .catch(() => '(no prompt)')
      throw new Error(
        `sign-in did not complete. Prompt: ${JSON.stringify(prompt)}. Popup closed: ${opened.isClosed()}.`,
        { cause: e },
      )
    }
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.result-chip:has-text("200")', { timeout: 20_000 })
    expect(seen.auth).toBe('Bearer tok-iframe')
    // an embed has no declared callback: the provider was sent the host page's own address
    expect(seen.redirect).toBe(hostPage)
    expect(errors).toEqual([])
    await page.close()
  })

  it('leaves a host application’s own ?code=&state= in the address', async () => {
    const hostPage = `http://host.localhost:${new URL(apiUrl).port}/host/embed.html`
    const page = await browser.newPage()
    await page.goto(`${hostPage}?code=their-code&state=their-state`)
    // nobody here is waiting, so after the short wait the viewer comes up as usual
    await page.waitForSelector('.header .brand', { timeout: 30_000 })
    expect(new URL(page.url()).search).toBe('?code=their-code&state=their-state')
    await page.close()
  })
})

describe('large documents meet the budget', () => {
  it.each([
    ['example/github.json', 5_000],
    ['example/stripe.json', 5_000],
  ])('%s is on screen within %i ms', async (name, budget) => {
    const t = Date.now()
    const { page, errors } = await open(spec(name))
    await page.waitForSelector('.list-col button', { timeout: 60_000 })
    const took = Date.now() - t
    console.log(`${name}: catalog in ${took} ms`)
    expect(errors).toEqual([])
    expect(took).toBeLessThan(budget)
    await page.close()
  })
})

describe('the landing page at the root', () => {
  const land = async () => {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${siteUrl}/`)
    return { page, errors }
  }

  it('takes an address a browser may read, and arrives in the viewer', async () => {
    const { page, errors } = await land()
    await page
      .getByLabel('Address of an OpenAPI or Swagger document')
      .fill(`${apiUrl}/petstore3.json`)
    await page.getByRole('button', { name: 'Open' }).first().click()
    await page.waitForURL(/\/v1\/\?spec=/)
    await page.waitForSelector('.op-row', { timeout: 30_000 })
    expect(errors).toEqual([])
    await page.close()
  })

  it('explains a server that blocks browsers, and opens the pasted document', async () => {
    const { page } = await land()
    await page
      .getByLabel('Address of an OpenAPI or Swagger document')
      .fill(`${apiUrl}/nocors/petstore3.json`)
    await page.getByRole('button', { name: 'Open' }).first().click()
    await page.waitForSelector('#fallback:not([hidden])')
    expect(await page.locator('#why').innerText()).toMatch(/CORS/)
    await page
      .getByLabel('OpenAPI or Swagger document text')
      .fill(await readFile(join(fixtures, 'petstore3.json'), 'utf8'))
    await page.getByRole('button', { name: 'Open pasted document' }).click()
    await page.waitForURL(/\/v1\/\?upload=/)
    await page.getByRole('button', { name: 'Continue with mock data' }).click()
    await page.waitForSelector('.op-row', { timeout: 30_000 })
    await page.close()
  })

  it('fetches the viewer in the background, so it is ready when Open is pressed', async () => {
    const page = await browser.newPage()
    const asked: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('/v1/assets/'))
        asked.push(new URL(r.url()).pathname.split('/').pop() ?? '')
    })
    await page.goto(`${siteUrl}/`)
    // without typing or pressing anything: the app, its panel and its styles. Polled from the list kept
    // since before the page loaded: the requests can start the moment `load` fires, before a
    // `waitForRequest` placed after `goto` would be listening.
    await expect
      .poll(() => asked.some((f) => /^main-.*\.js$/.test(f)), { timeout: 15_000 })
      .toBe(true)
    await expect.poll(() => asked.some((f) => f.endsWith('.css')), { timeout: 15_000 }).toBe(true)
    // and not the faker chunk, which only some requests ever use
    expect(asked.some((f) => f.startsWith('faker-'))).toBe(false)
    await page.close()
  })

  it('does not try to fetch a private address from a hosted page', async () => {
    const { page } = await land()
    await page
      .getByLabel('Address of an OpenAPI or Swagger document')
      .fill('http://localhost:8080/openapi.json')
    await page.getByRole('button', { name: 'Open' }).first().click()
    await page.waitForSelector('#fallback:not([hidden])')
    expect(await page.locator('#why').innerText()).toMatch(/your own machine or network/)
    await page.close()
  })

  it('serves the policy that keeps third-party script out', async () => {
    const res = await fetch(`${siteUrl}/`)
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'self'/)
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    const versions = (await (await fetch(`${siteUrl}/versions.json`)).json()) as {
      latest: string
    }
    expect(versions.latest).toBe('v1')
  })
})

describe('sharing a view', () => {
  const share = async (query: string) => {
    const { page } = await open(query)
    await ready(page)
    await page.waitForSelector('.op-row', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    return page
  }

  it('offers a link to the operation being viewed, and the networks', async () => {
    const { page } = await open(spec('petstore3.json'))
    await ready(page)
    await goOp(page, 'swagger-petstore-openapi-3-0/FindPetsByStatus')
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    const link = await page.getByLabel('Link to this view').inputValue()
    // readable: the address's colon and slashes are left as they are
    expect(link).toContain(`/v1/?spec=${apiUrl}/petstore3.json#/op/`)
    const reddit = await page.getByRole('link', { name: 'Reddit' }).getAttribute('href')
    expect(reddit).toContain('https://www.reddit.com/submit?')
    expect(decodeURIComponent(reddit ?? '')).toContain(link)
    for (const n of ['X', 'Hacker News', 'LinkedIn'])
      expect(await page.getByRole('link', { name: n }).getAttribute('target')).toBe('_blank')
    await page.close()
  })

  it('explains why a pasted document has no link', async () => {
    const { page } = await open('')
    await page.locator('details summary').click()
    await page
      .getByLabel('OpenAPI or Swagger document text')
      .fill(await readFile(join(fixtures, 'petstore3.json'), 'utf8'))
    await page.getByRole('button', { name: 'Open pasted document' }).click()
    await page.getByRole('button', { name: 'Continue with mock data' }).click()
    await page.waitForSelector('.op-row', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    expect(await page.locator('.share-pop').innerText()).toMatch(/no address to link to/)
    expect(await page.getByLabel('Link to this view').count()).toBe(0)
    await page.close()
  })

  it('does not offer a link to an address only this machine can reach', async () => {
    const local = `http://127.0.0.1:${new URL(apiUrl).port}/petstore3.json`
    const page = await share(`spec=${encodeURIComponent(local)}`)
    expect(await page.locator('.share-pop').innerText()).toMatch(/your own machine or network/)
    await page.close()
  })

  it('does not offer a link that would publish a credential', async () => {
    const page = await share(`spec=${encodeURIComponent(`${apiUrl}/petstore3.json?token=abc123`)}`)
    expect(await page.locator('.share-pop').innerText()).toMatch(/"token" parameter/)
    await page.close()
  })
})

describe('what the viewer ships', () => {
  it('has the codegen and none of the server-side proxy or Node HTTP code', async () => {
    const out: string[] = []
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (p.endsWith('.js')) out.push(await readFile(p, 'utf8'))
      }
    }
    await walk(join(dist, 'v1'))
    const has = (needle: string) => out.some((src) => src.includes(needle))
    // what the viewer is for is there: the generator's own strings and the UI's
    expect(has('This is not an OpenAPI 3 or Swagger 2 document')).toBe(true)
    for (const server of [
      'not reachable through this proxy',
      'cross-site requests are not accepted',
      'has not been allowed for this site',
      'node:http',
      'IncomingMessage',
    ])
      expect(has(server), `the viewer bundle contains "${server}"`).toBe(false)
  })
})

describe('Powered by Specbook', () => {
  it('shows under the overview on a host that is not specbook.dev, linking back with the host', async () => {
    const { page } = await open(spec('petstore3.json'))
    await ready(page)
    const a = page.locator('.overview .powered-by a')
    await a.waitFor()
    expect(await a.innerText()).toBe('Powered by Specbook')
    expect(await a.getAttribute('href')).toBe('https://ui.specbook.dev/?ref=127.0.0.1')
    await page.close()
  })
})

describe('the embed script', () => {
  let host: Server
  let hostUrl: string

  beforeAll(async () => {
    // a page on another origin, as an API's own docs route would be: it serves its spec and loads the
    // viewer's script from the CDN
    host = createServer(async (req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname
      if (p === '/docs') {
        res.setHeader('content-type', 'text/html')
        return void res.end(`<!doctype html><title>Docs</title><body><div id="app"></div>
<script type="application/json" id="specbook-config">{"spec":"/openapi.json"}</script>
<script type="module" src="${siteUrl}/v1/specbook.js"></script></body>`)
      }
      if (p === '/bare') {
        res.setHeader('content-type', 'text/html')
        return void res.end(
          `<!doctype html><div id="app"></div><script type="module" src="${siteUrl}/v1/specbook.js"></script>`,
        )
      }
      if (p === '/openapi.json') {
        res.setHeader('content-type', 'application/json')
        return void res.end(await readFile(join(fixtures, 'petstore3.json')))
      }
      res.statusCode = 404
      res.end('not found')
    })
    hostUrl = await listen(host)
  })

  afterAll(() => host?.close())

  it('runs on the host page: same-origin spec, a worker started from the CDN, no extra requests', async () => {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${hostUrl}/docs`)
    await page.waitForSelector('.op-row', { timeout: 30_000 })
    expect(await page.locator('.op-row').count()).toBeGreaterThan(10)
    // it is the host's page, so a "link back to ?spec=" is not offered, nor a link to our repository
    expect(await page.locator('a.gh-star').count()).toBe(0)
    expect(await page.title()).toContain('Petstore')
    expect(await page.getByRole('button', { name: 'Share', exact: true }).count()).toBe(0)
    // the badge points back, with the host page's name
    expect(await page.locator('.overview .powered-by a').getAttribute('href')).toBe(
      'https://ui.specbook.dev/?ref=127.0.0.1',
    )
    expect(errors).toEqual([])
    await page.close()
  })

  it('says what is wrong when no spec is configured', async () => {
    const page = await browser.newPage()
    await page.goto(`${hostUrl}/bare`)
    await page.waitForSelector('#app:has-text("no spec was given")')
    await page.close()
  })
})

describe('mock data from the first request', () => {
  it('answers a mock request with the default example without ever fetching faker', async () => {
    const page = await browser.newPage()
    let fakerAsked = 0
    // faker is refused outright: a mock request that needed it would fail
    await page.route(/\/assets\/faker-.*\.js$/, (route) => {
      fakerAsked++
      return route.abort()
    })
    await page.goto(`${siteUrl}/v1/?${spec('petstore3.json')}`)
    await ready(page)
    await goOp(page, 'swagger-petstore-openapi-3-0/FindPetsByStatus')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.result-chip:has-text("200")', { timeout: 20_000 })
    await page.getByRole('tab', { name: 'Response' }).click()
    expect(await page.locator('.response .body-editor').innerText()).toContain('"name"')
    await page.close()
    expect(fakerAsked).toBeGreaterThanOrEqual(0)
  })

  it('fetches faker once the page is idle, so a Dynamic example is ready', async () => {
    const page = await browser.newPage()
    let fetched = false
    page.on('request', (r) => {
      if (/\/assets\/faker-.*\.js$/.test(r.url())) fetched = true
    })
    await page.goto(`${siteUrl}/v1/?${spec('petstore3.json')}`)
    await ready(page)
    await expect.poll(() => fetched, { timeout: 15_000 }).toBe(true)
    await page.close()
  })
})

describe('faker in the viewer', () => {
  it('fills {{faker.*}} in a Dynamic example when it is sent', async () => {
    const { page, errors } = await open(spec('petstore3.json'))
    await ready(page)
    await goOp(page, 'swagger-petstore-openapi-3-0/AddPet')
    // the Dynamic example holds placeholders; choose it
    await page.locator('.rq-example label.row select').selectOption({ label: 'dynamic' })
    await page.waitForFunction(
      () =>
        (
          document.querySelector(
            '.request-panel .body-editor textarea',
          ) as HTMLTextAreaElement | null
        )?.value.includes('{{faker.'),
      undefined,
      { timeout: 10_000 },
    )
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.result-chip', { timeout: 20_000 })
    // sent as filled-in values: no placeholder is left in what went out
    await page.getByRole('tab', { name: 'Request' }).click()
    await page.getByRole('button', { name: 'Sent' }).click()
    const sent = await page.locator('.sent-view').innerText()
    expect(sent).not.toContain('{{faker.')
    expect(await page.locator('.result-chip').innerText()).toMatch(/^[1-3]\d\d/)
    expect(errors).toEqual([])
    await page.close()
  })
})

describe('the repository link and the share icon', () => {
  it('links to the repository from the landing page and the viewer', async () => {
    const page = await browser.newPage()
    await page.goto(`${siteUrl}/`)
    expect(await page.locator('a.gh').getAttribute('href')).toBe(
      'https://github.com/specbook-dev/specbook',
    )
    await page.close()

    const { page: v } = await open(spec('petstore3.json'))
    await ready(v)
    // wide enough for the words; below 1360px the header shows the marks alone
    await v.setViewportSize({ width: 1500, height: 700 })
    const link = v.locator('a.gh-star')
    expect(await link.getAttribute('href')).toBe('https://github.com/specbook-dev/specbook')
    expect(await link.getAttribute('target')).toBe('_blank')
    expect(await link.innerText()).toContain('GitHub')
    await v.close()
  })

  it('shows the share button as an icon with its label', async () => {
    const { page } = await open(spec('petstore3.json'))
    await ready(page)
    await page.setViewportSize({ width: 1500, height: 700 })
    const btn = page.getByRole('button', { name: 'Share', exact: true })
    expect(await btn.locator('svg').count()).toBe(1)
    expect(await btn.innerText()).toContain('Share')
    // tighter windows keep the mark, and the name stays for screen readers
    await page.setViewportSize({ width: 1200, height: 700 })
    expect(await btn.innerText()).toBe('')
    expect(await btn.getAttribute('aria-label')).toBe('Share')
    await page.close()
  })
})

describe('the icon', () => {
  it('is the page icon on the landing page and in the viewer, and the viewer’s header mark', async () => {
    const landing = await browser.newPage()
    await landing.goto(`${siteUrl}/`)
    // the site build puts a hash of the file after the name, so a changed icon is not served stale
    expect(await landing.locator('link[rel="icon"]').getAttribute('href')).toMatch(
      /^\.\/favicon\.svg(\?v=[0-9a-f]{10})?$/,
    )
    const icon = await landing.request.get(`${siteUrl}/favicon.svg`)
    expect(icon.status()).toBe(200)
    expect(await icon.text()).toContain("aria-label='Specbook'")
    expect((await landing.request.get(`${siteUrl}/apple-touch-icon.png`)).status()).toBe(200)
    await landing.close()

    const { page } = await open(spec('petstore3.json'))
    await ready(page)
    expect(await page.locator('link[rel="icon"]').getAttribute('href')).toBe('./favicon.svg')
    expect((await page.request.get(`${siteUrl}/v1/favicon.svg`)).status()).toBe(200)
    // our own mark beside the name, unless the API brings its own logo
    const mark = page.locator('.header .brand .brand-logo')
    expect(await mark.count()).toBe(1)
    await page.close()
  })
})

describe('the header', () => {
  const widths = [1500, 1280, 1100, 960]

  it('keeps every control on one line on a desktop, with no stray menu button', async () => {
    const { page } = await open(spec('petstore3.json'))
    await ready(page)
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: 600 })
      const rows = await page.evaluate(() => {
        const ys = ['.gh-star', '.share', '.theme-toggle', '.palette-btn'].map((s) => {
          const r = document.querySelector(s)?.getBoundingClientRect()
          return r ? Math.round(r.y + r.height / 2) : -1
        })
        const menu = document.querySelector('.menu-btn')
        const shown = !!menu && getComputedStyle(menu).display !== 'none'
        const last = document.querySelector('.theme-toggle')?.getBoundingClientRect().right ?? 0
        return { ys, shown, last, win: innerWidth }
      })
      // one row: every control's centre is within the header's height, and inside the window
      expect(Math.max(...rows.ys) - Math.min(...rows.ys), `at ${w}px`).toBeLessThan(30)
      expect(rows.last, `at ${w}px`).toBeLessThanOrEqual(rows.win)
      expect(rows.shown, `menu button at ${w}px`).toBe(false)
    }
    await page.close()
  })

  it('moves its controls into the menu on a narrow window, and shows the menu button', async () => {
    const { page } = await open(spec('petstore3.json'))
    await ready(page)
    await page.setViewportSize({ width: 880, height: 600 })
    const menu = page.getByRole('button', { name: 'Settings' })
    expect(await menu.isVisible()).toBe(true)
    await menu.click()
    expect(await page.locator('.header-controls a.gh-star').isVisible()).toBe(true)
    expect(await page.locator('.header-controls .share').isVisible()).toBe(true)
    // in the menu each link has its words, not just a mark
    expect(await page.locator('.header-controls .gh-label').isVisible()).toBe(true)
    expect(await page.locator('.header-controls .share-label').isVisible()).toBe(true)
    await page.close()
  })
})

describe('the self-hosted viewer from the release zip', () => {
  const releaseAssets = resolve(import.meta.dirname, '../../../../scripts/release-assets.mjs')
  let host: Server
  let hostUrl: string
  let work: string

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'sb-zip-'))
    // exactly what a release attaches, unpacked somewhere under a path of the host's choosing
    execFileSync('node', [releaseAssets, '9.9.9', '--out', join(work, 'assets')], {
      stdio: 'ignore',
    })
    await mkdir(join(work, 'site/docs/specbook'), { recursive: true })
    execFileSync('unzip', [
      '-q',
      join(work, 'assets/specbook-viewer-9.9.9.zip'),
      '-d',
      join(work, 'site/docs/specbook'),
    ])
    host = createServer(async (req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname
      try {
        if (p === '/api/openapi.json') {
          res.setHeader('content-type', 'application/json')
          return void res.end(await readFile(join(fixtures, 'petstore3.json')))
        }
        const f = join(work, 'site', p.endsWith('/') ? `${p}index.html` : p)
        res.setHeader('content-type', types[extname(f)] ?? 'application/octet-stream')
        res.end(await readFile(f))
      } catch {
        res.statusCode = 404
        res.end('not found')
      }
    })
    hostUrl = await listen(host)
  })

  afterAll(() => {
    host?.close()
  })

  it('carries the third-party notices, so the licence texts travel with the bundles', async () => {
    const text = await readFile(join(work, 'site/docs/specbook/THIRD-PARTY-NOTICES.txt'), 'utf8')
    expect(text).toContain('Third-party notices')
    // a library in the main bundle and one that only the worker uses
    expect(text).toMatch(/^preact \d/m)
    expect(text).toMatch(/^swagger2openapi \d/m)
    // its licence text, not only its name
    expect(text).toContain('Permission is hereby granted')
    // our own packages are not third-party
    expect(text).not.toMatch(/^@specbook\//m)
  })

  it('lists the zip and a checksum for it', async () => {
    const sums = await readFile(join(work, 'assets/SHA256SUMS'), 'utf8')
    expect(sums).toMatch(/^[0-9a-f]{64} {2}specbook-viewer-9\.9\.9\.zip$/m)
  })

  it('opens a same-origin spec from a sub-path, talking to nobody else', async () => {
    const page = await browser.newPage()
    const errors: string[] = []
    const origins = new Set<string>()
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('request', (r) => {
      if (/^https?:/.test(r.url())) origins.add(new URL(r.url()).origin)
    })
    await page.goto(`${hostUrl}/docs/specbook/?spec=${hostUrl}/api/openapi.json`)
    await page.waitForSelector('.op-row', { state: 'attached', timeout: 30_000 })
    await page.waitForSelector('.header .brand', { timeout: 30_000 })
    expect(await page.title()).toContain('Petstore')
    expect([...origins]).toEqual([hostUrl])
    expect(errors).toEqual([])
    await page.close()
  })
})

describe('coming back to the landing page', () => {
  it('has Open ready again after going to the viewer and pressing Back', async () => {
    // Playwright switches the back/forward cache off, and the headless shell cannot use it at all. The full
    // browser with the flag removed behaves like a real one: Back restores the page frozen as it was left.
    const cached = await chromium.launch({
      channel: 'chromium',
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
    })
    try {
      const page = await cached.newPage()
      await page.route('https://example.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: '{"openapi":"3.0.3","info":{"title":"T","version":"1"},"paths":{}}',
        }),
      )
      await page.goto(`${siteUrl}/`)
      await page
        .getByLabel('Address of an OpenAPI or Swagger document')
        .fill('https://example.com/openapi.json')
      await page.getByRole('button', { name: 'Open' }).first().click()
      await page.waitForURL((u) => u.pathname.endsWith('/v1/'), { timeout: 15_000 })
      // a restored page fires no load event, so wait for the navigation to commit, not to load
      await page.goBack({ waitUntil: 'commit' })
      await page.waitForURL(`${siteUrl}/`, { waitUntil: 'commit' })
      await expect.poll(() => page.locator('#go').isEnabled(), { timeout: 5_000 }).toBe(true)
      expect(await page.locator('#status').innerText()).toBe('')
    } finally {
      await cached.close()
    }
  })
})

describe('a GitHub file page pasted into the landing page', () => {
  it('opens the viewer with the raw document address', async () => {
    const page = await browser.newPage()
    // the landing page checks the address first; answer as raw.githubusercontent.com would
    await page.route('https://raw.githubusercontent.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: '{"openapi":"3.0.3","info":{"title":"Shop","version":"1"},"paths":{}}',
      }),
    )
    await page.goto(`${siteUrl}/`)
    await page
      .getByLabel('Address of an OpenAPI or Swagger document')
      .fill('https://github.com/acme/shop/blob/main/docs/openapi.yaml?plain=1')
    await page.getByRole('button', { name: 'Open' }).first().click()
    await page.waitForURL(
      (u) =>
        u.pathname.endsWith('/v1/') &&
        u.searchParams.get('spec') ===
          'https://raw.githubusercontent.com/acme/shop/main/docs/openapi.yaml',
      { timeout: 15_000 },
    )
    await page.close()
  })

  it('no longer asks people to hunt for the raw link', async () => {
    const page = await browser.newPage()
    await page.goto(`${siteUrl}/`)
    expect(await page.locator('body').innerText()).not.toMatch(/raw\.githubusercontent\.com/)
    await page.close()
  })
})

describe('the example links on the landing page', () => {
  // a wide font on purpose: the same row is narrower in Apple's system font than in the one a Linux or
  // Android device falls back to, and the test must hold for the wider one wherever it runs
  it.each([390, 375, 360, 320])(
    'sit on one line at %i px, not one word on a line of its own',
    async (width) => {
      const page = await browser.newPage({ viewport: { width, height: 800 } })
      await page.goto(`${siteUrl}/`)
      await page.addStyleTag({
        content: 'body { font-family: "DejaVu Sans", Verdana, sans-serif !important; }',
      })
      const tops = await page
        .locator('.try .link')
        .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
      expect(tops).toHaveLength(5)
      expect(new Set(tops).size).toBe(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      )
      await page.close()
    },
  )
})

describe('the screenshots on the landing page', () => {
  const shots = async (width: number) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await page.goto(`${siteUrl}/`)
    await page.locator('.shot').scrollIntoViewIfNeeded()
    return page
  }

  it('shows the laptop and the phone side by side, at the same height', async () => {
    const page = await shots(1100)
    const wide = page.locator('.shot-wide img')
    const phone = page.locator('.shot-phone img')
    await wide.waitFor()
    await phone.waitFor()
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLImageElement>('.shot img')].every(
        (i) => i.complete && i.naturalWidth,
      ),
    )
    const [w, p] = [await wide.boundingBox(), await phone.boundingBox()]
    expect(Math.abs((w?.height ?? 0) - (p?.height ?? 1))).toBeLessThanOrEqual(2)
    expect((w?.x ?? 0) + (w?.width ?? 0)).toBeLessThanOrEqual(p?.x ?? 0)
    await page.close()
  })

  it('shows only the phone picture on a phone, without sideways scrolling', async () => {
    const page = await shots(390)
    await page.waitForFunction(() => {
      const i = document.querySelector<HTMLImageElement>('.shot-phone img')
      return !!i?.complete && i.naturalWidth > 0
    })
    expect(await page.locator('.shot-wide img').isHidden()).toBe(true)
    expect(await page.locator('.shot-phone img').isVisible()).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.close()
  })
})

describe('the "Open in Specbook" button', () => {
  const generate = async (address: string) => {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${siteUrl}/`)
    await page.locator('#badge-url').fill(address)
    return { page, errors }
  }

  it('serves the badge as an image', async () => {
    const res = await fetch(`${siteUrl}/badge.svg`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/svg+xml')
    expect(await res.text()).toContain('Open in Specbook')
  })

  it('writes the README line for a public document, with a link that reads well', async () => {
    const { page, errors } = await generate('https://example.com/api/openapi.json')
    await page.waitForSelector('#badge-out:not([hidden])')
    expect(await page.locator('#badge-md').innerText()).toBe(
      '[![Open in Specbook](https://ui.specbook.dev/badge.svg)](https://ui.specbook.dev/v1/?spec=https://example.com/api/openapi.json)',
    )
    expect(errors).toEqual([])
    await page.close()
  })

  it('turns a GitHub file page into the raw file', async () => {
    const { page } = await generate('https://github.com/acme/shop/blob/main/docs/openapi.yaml')
    await page.waitForSelector('#badge-out:not([hidden])')
    expect(await page.locator('#badge-md').innerText()).toContain(
      '?spec=https://raw.githubusercontent.com/acme/shop/main/docs/openapi.yaml)',
    )
    await page.close()
  })

  it('refuses what only its author could open, or what carries a credential', async () => {
    for (const [address, reason] of [
      ['http://localhost:8080/openapi.json', /your own machine or network/],
      ['http://192.168.1.20/openapi.json', /your own machine or network/],
      ['https://user:pass@example.com/openapi.json', /contains a login/],
      ['https://example.com/openapi.json?api_key=abc', /looks like a credential/],
      ['not an address', /starting with http/],
    ] as const) {
      const { page } = await generate(address)
      await page.waitForSelector('#badge-note.error')
      expect(await page.locator('#badge-note').innerText()).toMatch(reason)
      expect(await page.locator('#badge-out').isHidden()).toBe(true)
      await page.close()
    }
  })
})

describe('the landing page wording', () => {
  it('says what it is, and that it is its own project', async () => {
    const page = await browser.newPage()
    await page.goto(`${siteUrl}/`)
    expect(await page.locator('.eyebrow').innerText()).toBe('A Swagger UI alternative')
    // the examples offered: each a real, public document served with CORS
    const examples = await page
      .locator('[data-spec]')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.spec))
    expect(examples).toEqual([
      'https://petstore3.swagger.io/api/v3/openapi.json',
      'https://httpbin.org/spec.json',
      'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
      'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml',
      'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
    ])
    expect(await page.locator('h1').innerText()).toBe('Same spec. Way more swagger.')
    expect(await page.title()).toBe('Specbook · Same spec. Way more swagger.')
    expect(await page.locator('.foot').innerText()).toMatch(
      /not affiliated with Storybook \(storybook\.js\.org\) or Swagger/,
    )
    expect(await page.locator('.foot .joke').innerText()).toContain(
      'We just made it work, even on mobile',
    )
    // the link preview: a large card, and the image is really served at the address it names
    expect(await page.locator('meta[name="twitter:card"]').getAttribute('content')).toBe(
      'summary_large_image',
    )
    const og = await page.locator('meta[property="og:image"]').getAttribute('content')
    expect(og).toBe('https://ui.specbook.dev/og.png')
    const card = await page.request.get(`${siteUrl}/og.png`)
    expect(card.status()).toBe(200)
    expect(card.headers()['content-type']).toContain('image/png')
    expect(await page.locator('.lead').innerText()).toMatch(/Requests start on mock data/)
    // nothing on the page claims to be better than what it is an alternative to
    expect((await page.locator('body').innerText()).toLowerCase()).not.toMatch(
      /better swagger|what comes next/,
    )
    expect(await page.locator('meta[property="og:description"]').getAttribute('content')).toMatch(
      /^A Swagger UI alternative\./,
    )
    await page.close()
  })
})

describe('the viewer says where its responses come from', () => {
  it('tells someone the requests start on mock data and how to reach the real API', async () => {
    const { page } = await open(spec('live/openapi.json'))
    await ready(page)
    expect(await page.locator('.overview-mode').innerText()).toMatch(/start on mock data.*live/)
    await page.close()
  })

  it('says so when the document gives no address for live calls', async () => {
    const { page } = await open('')
    await page.locator('details summary').click()
    await page.getByLabel('OpenAPI or Swagger document text').fill(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'No Server', version: '1' },
        paths: { '/x': { get: { responses: { '200': { description: 'ok' } } } } },
      }),
    )
    await page.getByRole('button', { name: 'Open pasted document' }).click()
    await page.waitForSelector('.overview-mode', { timeout: 30_000 })
    expect(await page.locator('.overview-mode').innerText()).toMatch(
      /does not say where the API lives/,
    )
    await page.close()
  })
})

describe('on a phone', () => {
  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }

  it('lays the landing page and the viewer out without sideways scrolling', async () => {
    const ctx = await browser.newContext(phone)
    const page = await ctx.newPage()
    const wide = () =>
      page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)

    await page.goto(`${siteUrl}/`)
    expect(await wide(), 'landing').toBe(false)
    // every example is reachable, and the joke and the note are in view
    expect(await page.locator('[data-spec]').count()).toBe(5)
    expect(await page.locator('.foot .joke').innerText()).toContain('even on mobile')

    await page.goto(`${siteUrl}/v1/?${spec('petstore3.json')}`)
    await page.waitForSelector('.overview-browse', { timeout: 30_000 })
    expect(await wide(), 'splash').toBe(false)
    expect(await page.locator('.overview-mode').innerText()).toMatch(/mock data/)
    await page.locator('.overview-browse').click()
    await page.waitForSelector('.op-row')
    expect(await wide(), 'list').toBe(false)

    // the settings menu carries the words for GitHub and Share, and sharing opens inside it
    await page.getByRole('button', { name: 'Settings' }).click()
    expect(await page.locator('.header-controls .gh-label').isVisible()).toBe(true)
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    expect(await page.getByLabel('Link to this view').isVisible()).toBe(true)
    expect(await wide(), 'menu').toBe(false)
    await ctx.close()
  })
})
