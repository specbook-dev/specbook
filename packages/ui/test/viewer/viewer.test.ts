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

/** A Spring service's document: springdoc gives every response a wildcard media type unless told what it produces. */
const wildcardSpec = (base: string) =>
  JSON.parse(
    JSON.stringify({ ...liveSpec(base), info: { title: 'Wildcard Things', version: '1' } }).replace(
      '"application/json"',
      '"*/*"',
    ),
  )

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
          // `! Name` lets go of a header an earlier rule set, as Pages does
          for (const [k, v] of r.headers)
            if ((k as string).startsWith('!')) res.removeHeader((k as string).slice(1).trim())
            else res.setHeader(k as string, v as string)
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
      if (p === '/wildcard/openapi.json') return void res.end(JSON.stringify(wildcardSpec(apiUrl)))
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
      // a page on another site that frames the hosted viewer (on the sign-in fixture's spec unless given one)
      if (p === '/host/iframe.html') {
        const q = new URL(req.url ?? '/', 'http://x').searchParams
        const spec = encodeURIComponent(q.get('spec') ?? `${apiUrl}/oauth/openapi.json`)
        // `bare`: the viewer with no document named
        const src = q.has('bare') ? `${siteUrl}/v1/` : `${siteUrl}/v1/?spec=${spec}`
        res.setHeader('content-type', 'text/html')
        return void res.end(
          `<!doctype html><iframe title="viewer" style="width:1000px;height:760px;border:0" src="${src}"></iframe>`,
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
    args: ['--host-resolver-rules=MAP api.fixture.test 127.0.0.1, MAP site.fixture.test 127.0.0.1'],
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
    // the 200 answer is a list of pets: the status tab says so and the table lists a pet's fields
    const pane = page.locator('.doc [role=tabpanel]')
    expect(
      await page.locator('.doc .statuses [role=tab][aria-selected=true]').innerText(),
    ).toContain('200')
    expect(await pane.locator('.body-type').innerText()).toContain('Pet[]')
    expect(await pane.locator('table.fields').innerText()).toContain('photoUrls')
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

  it('keeps a link the browser may not read where it is: the error, the address to edit, and the paste box', async () => {
    const { page } = await open(spec('nocors/petstore3.json'))
    await page.waitForSelector('.vw-error')
    expect(await page.locator('.vw-error').innerText()).toMatch(/CORS/)
    expect(await page.locator('.vw-error').innerText()).toMatch(/Paste the document below/)
    // no trip to another page: the address is still in the box, to be fixed, and the link is still the address bar's
    expect(page.url()).toContain('/v1/?spec=')
    expect(
      await page.getByLabel('Address of an OpenAPI or Swagger document').inputValue(),
    ).toContain('/nocors/petstore3.json')
    // the same document, pasted, opens
    const text = await readFile(join(fixtures, 'petstore3.json'), 'utf8')
    await page.getByLabel('OpenAPI or Swagger document text').fill(text)
    await page.getByRole('button', { name: 'Open pasted document' }).click()
    await page.waitForURL(/\/v1\/\?upload=/)
    // a relative `servers` entry has no address of its own: the person is asked, and may skip it
    await page.getByRole('button', { name: 'Continue with mock data' }).click()
    await page.waitForSelector('.op-row', { timeout: 30_000 })
    await page.close()
  })

  it('says why a hosted page cannot read a link to the visitor’s own machine, and a file address', async () => {
    // served from a public-looking name, as the hosted site is
    const hosted = `http://site.fixture.test:${new URL(siteUrl).port}`
    for (const address of ['http://localhost:9/openapi.json', 'file:///Users/me/openapi.json']) {
      const page = await browser.newPage()
      await page.goto(`${hosted}/v1/?spec=${encodeURIComponent(address)}`)
      await page.waitForSelector('.vw-error')
      const said = await page.locator('.vw-error').innerText()
      expect(said).toMatch(/your own machine or network, which a hosted page cannot reach/)
      expect(said).toMatch(/Paste the document below/)
      expect(page.url()).toContain('/v1/?spec=')
      await page.close()
    }
  })

  it('does not say that of a copy served from a private address, which reaches them as anyone', async () => {
    // the fixture site is on 127.0.0.1
    const { page } = await open(`spec=${encodeURIComponent('http://localhost:9/openapi.json')}`)
    await page.waitForSelector('.vw-error')
    const said = await page.locator('.vw-error').innerText()
    expect(said).toMatch(/CORS/)
    expect(said).not.toMatch(/hosted page cannot reach/)
    await page.close()
  })

  it('shows only the error, in the frame, when a viewer embedded on another site cannot open its document', async () => {
    const page = await browser.newPage()
    const blocked = encodeURIComponent(`${apiUrl}/nocors/petstore3.json`)
    await page.goto(`${apiUrl}/host/iframe.html?spec=${blocked}`)
    const frame = page.frameLocator('iframe[title="viewer"]')
    await frame.locator('.vw-error').waitFor({ timeout: 30_000 })
    expect(await frame.locator('.vw-error').innerText()).toMatch(/CORS/)
    // nothing of the viewer's own page: the paste box and examples are for the visitor of the viewer's
    // site, and so is the advice to use them
    expect(await frame.locator('.vw-error').innerText()).not.toMatch(/Paste the document/)
    expect(await frame.getByLabel('Address of an OpenAPI or Swagger document').count()).toBe(0)
    expect(await frame.locator('.vw-paste, .vw-drop, ul').count()).toBe(0)
    expect(await frame.getByText('Try one').count()).toBe(0)
    // the frame did not become the home page, and the host page was not taken anywhere
    const inner = page.frames().find((f) => f !== page.mainFrame())
    expect(inner?.url()).toContain('/v1/?spec=')
    expect(page.url()).toContain('/host/iframe.html')
    await page.close()
  })

  it('still offers the picker to a viewer embedded with no document named', async () => {
    const page = await browser.newPage()
    await page.goto(`${apiUrl}/host/iframe.html?bare=1`)
    const frame = page.frameLocator('iframe[title="viewer"]')
    await frame.getByLabel('Address of an OpenAPI or Swagger document').waitFor({ timeout: 30_000 })
    expect(await frame.getByText('Try one').count()).toBe(1)
    // a link to Specbook's own home page is for the page when it is the site's, not inside another site's frame
    expect(await frame.getByText('What is Specbook?').count()).toBe(0)
    await page.close()
  })

  it('shows the picker as the hosted site’s own page, with its mark and a way to the home page', async () => {
    const { page } = await open('')
    await page.waitForSelector('.vw-brand img', { timeout: 20_000 })
    // pasting is there from the start, not behind something to open (the page does not jump when it is wanted)
    expect(await page.getByText('Or paste the document').isVisible()).toBe(true)
    expect(await page.getByLabel('OpenAPI or Swagger document text').isVisible()).toBe(true)
    expect(await page.locator('.vw h1').innerText()).toBe('Specbook')
    const home = page.getByRole('link', { name: 'What is Specbook?' })
    expect(await home.getAttribute('href')).toBe('/')
    // the examples are things to press, side by side
    expect(await page.locator('.vw-chips .vw-chip').count()).toBeGreaterThanOrEqual(3)
    await page.close()
  })

  it('reopens an uploaded document after a reload', async () => {
    const { page } = await open('')
    const text = await readFile(join(fixtures, 'petstore3.json'), 'utf8')
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
    // the server did answer, so the paste box would not help: this one is explained where it is
    expect(page.url()).toContain('/v1/?spec=')
    await page.close()
  })

  it('checks a response against the schema a document declares under */*', async () => {
    const { page } = await open(spec('wildcard/openapi.json'))
    await ready(page)
    await goOp(page, 'wildcard-things/ListThings')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.result-chip:has-text("200")', { timeout: 20_000 })
    await page.waitForSelector('.response .conf:has-text("Matches spec")', { timeout: 10_000 })
    expect(await page.locator('.response .conf').innerText()).not.toMatch(/No schema/)
    await page.close()
  })

  it('shows each variant of a polymorphic list: the response, its check, and the docs', async () => {
    const { page } = await open(spec('bookstore.json'))
    await ready(page)
    await goOp(page, 'bookstore/ListShelf')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.result-chip:has-text("200")', { timeout: 20_000 })
    await page.waitForSelector('.response .conf:has-text("Matches spec")', { timeout: 10_000 })
    // one item of each kind, each tagged by the discriminator the document maps it to
    await page.waitForFunction(
      () =>
        /"kind": "book"[\s\S]*"kind": "album"[\s\S]*"kind": "Zine"/.test(document.body.innerText),
      undefined,
      { timeout: 10_000 },
    )

    // the request body names its variants instead of saying "object", with a heading for each
    await goOp(page, 'bookstore/AddItems')
    await page.getByRole('tab', { name: 'Docs' }).click()
    await page.waitForSelector('.doc table.fields tr.variant', { timeout: 10_000 })
    expect(
      await page
        .locator('.doc table.fields')
        .first()
        .locator('tr.variant .variant-name')
        .allInnerTexts(),
    ).toEqual(['Book', 'Album', 'Zine'])
    expect(await page.locator('.doc table.fields').first().innerText()).toContain(
      '(Book | Album | Zine)[]',
    )
    await page.close()
  })

  it('documents each status of an operation: what it says, what comes back, and what is in it', async () => {
    const { page } = await open(spec('bookstore.json'))
    await ready(page)
    await goOp(page, 'bookstore/ListShelf')
    await page.getByRole('tab', { name: 'Docs' }).click()
    await page.waitForSelector('.doc .statuses [role=tab]', { timeout: 10_000 })
    const tabs = await page.locator('.doc .statuses [role=tab]').allInnerTexts()
    expect(tabs.map((t) => t.replace(/\s+/g, ' '))).toEqual(['200 OK', '409 Conflict'])
    // the answer is a shelf whose items are of three kinds, closed until a person opens them
    const pane = page.locator('.doc [role=tabpanel]')
    expect(await pane.locator('.body-type').innerText()).toContain('Shelf')
    expect(await pane.innerText()).toContain('The shelf')
    expect(await pane.locator('tr.variant .variant-name').allInnerTexts()).toEqual([
      'Book',
      'Album',
      'Zine',
    ])
    const before = await pane.locator('table.fields tr').count()
    await pane.getByRole('button', { name: 'Show what is in items', exact: true }).click()
    expect(await pane.locator('table.fields tr').count()).toBeGreaterThan(before)
    // an object among them is a group of its own, named by its whole path, opened in its turn
    expect(await pane.locator('table.fields').innerText()).toContain('items.related')
    await pane.getByRole('button', { name: 'Show what is in items.related', exact: true }).click()
    expect(await pane.locator('table.fields').innerText()).toContain('tracks')
    // the other status is a different answer: two kinds of error, each with its own fields
    await page.getByRole('tab', { name: /409/ }).click()
    expect(await pane.locator('.body-type').innerText()).toContain('OutOfStock | Discontinued')
    expect(await pane.innerText()).toContain('Not available')
    expect(await pane.locator('tr.variant .variant-name').allInnerTexts()).toEqual([
      'OutOfStock',
      'Discontinued',
    ])
    expect(await pane.locator('table.fields').innerText()).toContain('sku')
    expect(await page.locator('.prism-code-editor').count()).toBe(0)
    await page.close()
  })

  it('lays a field table out for a phone: stacked, nothing scrolling sideways, a variant’s tag on one line', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.goto(`${siteUrl}/v1/?${spec('bookstore.json')}`)
    await ready(page)
    await goOp(page, 'bookstore/AddItems')
    await page.getByRole('tab', { name: 'Docs' }).click()
    await page.waitForSelector('.doc table.fields tr.variant', { timeout: 10_000 })
    // open the list of variants: the fields under it are as far in as any field ever goes
    await page.getByRole('button', { name: 'Show what is in items', exact: true }).first().click()
    await page.waitForSelector('.doc table.fields tr:has-text("title")')
    const fit = await page.evaluate(() =>
      [...document.querySelectorAll('table.fields')].map((t) => t.scrollWidth <= t.clientWidth + 1),
    )
    expect(fit.length).toBeGreaterThan(0)
    expect(fit.every(Boolean)).toBe(true)
    // `kind = "book"` is read as one thing: a single line, not "kind =" over "book"
    const tag = await page.locator('table.fields tr.variant .chip').first().boundingBox()
    expect(tag?.height).toBeLessThan(24)
    // what a field says sits under its name, not in a column the table has to scroll to reach
    const [name, said] = await page.evaluate(() => {
      const row = [...document.querySelectorAll('table.fields tr')].find((r) =>
        r.textContent?.includes('title'),
      ) as HTMLElement
      return [row.children[0], row.children[row.children.length - 1]].map(
        (c) => (c as HTMLElement).getBoundingClientRect().top,
      )
    })
    expect(said).toBeGreaterThanOrEqual(name as number)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.close()
  })

  it('offers each variant of a status in Respond with, and answers the one picked', async () => {
    const { page } = await open(spec('bookstore.json'))
    await ready(page)
    await goOp(page, 'bookstore/ListShelf')
    const picker = page.getByLabel('Mock response')
    const options = await picker.locator('option').allInnerTexts()
    expect(options.map((o) => o.replace(/\s+/g, ' ').trim())).toEqual([
      'Default',
      '200 OK',
      '409 Conflict · OutOfStock',
      '409 Conflict · Discontinued',
    ])

    // the second variant answers: its status, its body, and the check against the response schema
    await picker.selectOption({ label: '409 Conflict · Discontinued' })
    await page.waitForSelector('.result-chip:has-text("409")', { timeout: 20_000 })
    await page.waitForFunction(
      () => document.body.innerText.includes('"DISCONTINUED"'),
      undefined,
      {
        timeout: 10_000,
      },
    )
    await page.waitForSelector('.response .conf:has-text("Matches spec")', { timeout: 10_000 })
    expect(await page.locator('.response').first().innerText()).not.toContain('OUT_OF_STOCK')

    // the first variant is the other option
    await picker.selectOption({ label: '409 Conflict · OutOfStock' })
    await page.waitForFunction(
      () => document.body.innerText.includes('"OUT_OF_STOCK"'),
      undefined,
      {
        timeout: 10_000,
      },
    )

    // Default goes back to the 200: it must not replay the status that was forced before
    await picker.selectOption({ label: 'Default' })
    await page.waitForSelector('.result-chip:has-text("200")', { timeout: 20_000 })
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
    // not given to Cloudflare to add its analytics script to: this address carries the authorization code
    expect(r.headers.get('cache-control')).toBe('no-cache, no-transform')
    expect(r.headers.get('content-security-policy')).not.toContain('cloudflareinsights')
    expect(r.headers.get('x-robots-tag')).toBe('noindex')
    expect(await r.text()).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
    // and the hosted viewer is told to send people there
    // the viewer page is measured by nothing; the home page alone may run the beacon
    const viewerRes = await fetch(`${siteUrl}/v1/`)
    expect(viewerRes.headers.get('content-security-policy')).not.toContain('cloudflareinsights')
    expect(viewerRes.headers.get('cache-control')).toContain('no-transform')
    expect((await fetch(`${siteUrl}/`)).headers.get('content-security-policy')).toContain(
      "script-src 'self' https://static.cloudflareinsights.com;",
    )
    const viewer = await viewerRes.text()
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

  it('hands an implicit-flow token from the address fragment to the waiting tab, then closes', async () => {
    const page = await browser.newPage()
    await page.goto(`${siteUrl}/`)
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
    await page.evaluate(() =>
      window.open('/oauth/callback/#access_token=t1&expires_in=60&scope=read&state=s2', 'cb'),
    )
    const opened = await popup
    if (!opened.isClosed()) await opened.waitForEvent('close', { timeout: 15_000 })
    const got = (await page.evaluate(
      () => (window as unknown as { __got: unknown[] }).__got,
    )) as unknown[]
    expect(got[0]).toEqual({
      type: 'callback',
      state: 's2',
      token: { accessToken: 't1', expiresIn: 60, scope: 'read' },
    })
    await page.close()
  })

  it('keeps a stray token out of the address when nobody is waiting', async () => {
    const page = await browser.newPage()
    await page.goto(`${siteUrl}/oauth/callback/#access_token=stray&state=stray`)
    await page.getByText('No Specbook window is waiting').waitFor({ timeout: 10_000 })
    expect(page.url()).toBe(`${siteUrl}/oauth/callback/`)
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

describe('the viewer does not wait on itself', () => {
  /** The wait a page's files add when each answer takes a fixed time to come back: with no limit on the line, it is all round trips. */
  const readyAfter = async (latency: number) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    const t = Date.now()
    await page.goto(`${siteUrl}/v1/?${spec('petstore3.json')}`, { waitUntil: 'commit' })
    // the groups of the real list: the page shows the app's shape before that, from a placeholder
    await page.waitForFunction(() => document.querySelectorAll('.group-head').length >= 2, null, {
      timeout: 60_000,
      polling: 25,
    })
    const took = Date.now() - t
    await context.close()
    return took
  }
  const median = (xs: number[]) =>
    [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number

  it('puts the list on screen within a fixed number of round trips', async () => {
    const LATENCY = 100
    const base = median([await readyAfter(0), await readyAfter(0), await readyAfter(0)])
    const slow = median([
      await readyAfter(LATENCY),
      await readyAfter(LATENCY),
      await readyAfter(LATENCY),
    ])
    const rounds = (slow - base) / LATENCY
    // Measured: about 5.5 with the app in the page's static imports, and about 6.6 when the app is behind a dynamic
    // import that the entry makes after it runs. A new step before the list is shown has to be worth a round trip.
    expect(rounds).toBeLessThan(6)
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

  it('keeps pasting a document one click away, closed until wanted, so the hero stays above the fold', async () => {
    const { page } = await land()
    const control = page.getByRole('button', { name: 'paste / choose a file' })
    expect(await control.getAttribute('aria-expanded')).toBe('false')
    expect(await page.locator('#fallback').isHidden()).toBe(true)
    await control.click()
    expect(await control.getAttribute('aria-expanded')).toBe('true')
    expect(await page.locator('#fallback').isVisible()).toBe(true)
    // it opens below the line that opened it, not above it
    const [row, block] = await Promise.all(
      ['.try', '#fallback'].map((sel) =>
        page.locator(sel).evaluate((e) => e.getBoundingClientRect().top),
      ),
    )
    expect(block as number).toBeGreaterThan(row as number)
    // opened by hand there is nothing to explain, and the box is ready to type or paste into
    expect(await page.locator('#why').isVisible()).toBe(false)
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('paste')
    // and it shows that, in the page's accent, not the browser's own blue
    const ring = await page.evaluate(() => {
      const box = getComputedStyle(document.getElementById('paste') as HTMLElement)
      const accent = getComputedStyle(document.querySelector('button.link') as HTMLElement).color
      return { style: box.outlineStyle, width: box.outlineWidth, same: box.outlineColor === accent }
    })
    expect(ring).toEqual({ style: 'solid', width: '2px', same: true })
    // a tap does not flash the browser's own blue box over the links and buttons
    const flash = await page.evaluate(() =>
      ['show-paste', 'open-paste'].map((id) =>
        getComputedStyle(document.getElementById(id) as HTMLElement).getPropertyValue(
          '-webkit-tap-highlight-color',
        ),
      ),
    )
    expect(flash).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
    await page
      .getByLabel('OpenAPI or Swagger document text')
      .fill(await readFile(join(fixtures, 'petstore3.json'), 'utf8'))
    await page.getByRole('button', { name: 'Open pasted document' }).click()
    await page.waitForURL(/\/v1\/\?upload=/)
    await page.getByRole('button', { name: 'Continue with mock data' }).click()
    await page.waitForSelector('.op-row', { timeout: 30_000 })
    await page.close()
  })

  it('closes it again, and a failed address still opens it with the reason', async () => {
    const { page } = await land()
    const control = page.getByRole('button', { name: 'paste / choose a file' })
    await control.click()
    await control.click()
    expect(await page.locator('#fallback').isHidden()).toBe(true)
    expect(await control.getAttribute('aria-expanded')).toBe('false')
    await page
      .getByLabel('Address of an OpenAPI or Swagger document')
      .fill('http://localhost:8080/openapi.json')
    await page.getByRole('button', { name: 'Open', exact: true }).first().click()
    await page.waitForSelector('#fallback:not([hidden])')
    expect(await control.getAttribute('aria-expanded')).toBe('true')
    expect(await page.locator('#why').innerText()).toMatch(/your own machine or network/)
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
    // no faker: not the library, and no chunk of it (a typed {{faker.*}} is refused instead)
    expect(
      await readdir(join(dist, 'v1/assets')).then((f) => f.filter((n) => /faker/.test(n))),
    ).toEqual([])
    expect(has('Aaliyah'), 'faker’s English name data is in the bundle').toBe(false)
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
    expect(await a.getAttribute('href')).toBe('https://docs.specbook.dev/?ref=127.0.0.1')
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
      if (p === '/docs-live') {
        res.setHeader('content-type', 'text/html')
        return void res.end(`<!doctype html><title>Docs</title><body><div id="app"></div>
<script type="application/json" id="specbook-config">{"spec":"/openapi.json","baseUrl":"${hostUrl}","defaultEnv":"live"}</script>
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
    // it is the host's page, so the host's title stays
    expect(await page.title()).toBe('Docs')
    expect(await page.getByRole('button', { name: 'Share', exact: true }).count()).toBe(0)
    // the badge points back, with the host page's name
    expect(await page.locator('.overview .powered-by a').getAttribute('href')).toBe(
      'https://docs.specbook.dev/?ref=127.0.0.1',
    )
    expect(errors).toEqual([])
    await page.close()
  })

  it('starts on mock, or on the environment defaultEnv names', async () => {
    const env = (page: Page) => page.getByLabel('Environment', { exact: true }).inputValue()
    const plain = await browser.newPage()
    await plain.goto(`${hostUrl}/docs`)
    await plain.waitForSelector('.op-row', { timeout: 30_000 })
    expect(await env(plain)).toBe('mock')
    await plain.close()
    const live = await browser.newPage()
    await live.goto(`${hostUrl}/docs-live`)
    await live.waitForSelector('.op-row', { timeout: 30_000 })
    await expect.poll(() => env(live)).toBe('live')
    await live.close()
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
    // well past the point where an idle prefetch would have run
    await page.waitForTimeout(3000)
    await page.close()
    expect(fakerAsked).toBe(0)
  })

  it('refuses a typed {{faker.*}} instead of sending it', async () => {
    const { page, errors } = await open(spec('petstore3.json'))
    await ready(page)
    await goOp(page, 'swagger-petstore-openapi-3-0/AddPet')
    const body = page.locator('.request-panel .body-editor textarea')
    await body.fill('{"name":"{{faker.person.firstName}}","photoUrls":["x"]}')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.result-chip', { timeout: 20_000 })
    expect(await page.locator('.response').innerText()).toContain('not in the hosted viewer')
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

  // our own font, then a wider one: a machine without ours falls back to whatever it has, and the header must still fit
  const fonts = [undefined, 'Verdana, "DejaVu Sans", sans-serif']

  it('keeps every control on one line on a desktop, with no stray menu button', async () => {
    const { page } = await open(spec('petstore3.json'))
    await ready(page)
    for (const [w, font] of widths.flatMap((w) => fonts.map((f) => [w, f] as const))) {
      if (font) await page.addStyleTag({ content: `:root { --sb-font-sans: ${font} !important }` })
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
      const at = `at ${w}px${font ? ' in a wide font' : ''}`
      expect(Math.max(...rows.ys) - Math.min(...rows.ys), at).toBeLessThan(30)
      expect(rows.last, at).toBeLessThanOrEqual(rows.win)
      expect(rows.shown, `menu button ${at}`).toBe(false)
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

  it('shows the picker without a link to a home page, which a copy of the viewer does not have', async () => {
    const page = await browser.newPage()
    await page.goto(`${hostUrl}/docs/specbook/`)
    await page.waitForSelector('.vw-brand img', { timeout: 20_000 })
    expect(await page.getByText('What is Specbook?').count()).toBe(0)
    await page.close()
  })

  it('explains an address it cannot read where it is: there is no landing page to send it to', async () => {
    const page = await browser.newPage()
    await page.goto(`${hostUrl}/docs/specbook/?spec=${encodeURIComponent('http://localhost:9/x')}`)
    await page.waitForSelector('.vw-error')
    expect(await page.locator('.vw-error').innerText()).toMatch(/CORS/)
    expect(page.url()).toContain('/docs/specbook/?spec=')
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
      // the examples: the control to paste or choose a file shares the row and may wrap to its own line
      const tops = await page
        .locator('.try [data-spec]')
        .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
      expect(tops).toHaveLength(5)
      expect(new Set(tops).size).toBe(1)
      const row = await page.evaluate(() => {
        const t = document.querySelector('.try') as HTMLElement
        return [t.scrollWidth, t.clientWidth]
      })
      expect(row[0]).toBeLessThanOrEqual(row[1] as number)
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
