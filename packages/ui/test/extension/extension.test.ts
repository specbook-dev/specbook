import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { freePort, startSite } from '../oauth/harness'

/**
 * The shipped extension (its test build, which already holds access to loopback and `*.fixture.test`, since a
 * browser permission prompt cannot be answered by a test), loaded into Chromium in front of the real viewer
 * and APIs that send no CORS headers at all. Build first: `pnpm test:extension` does.
 */

const extension = resolve(import.meta.dirname, '../../../extension/dist/chromium-test')

interface Seen {
  api: string
  method: string
  url: string
  cookie?: string
  authorization?: string
  origin?: string
}
const seen: Seen[] = []

function startApi(name: string, port: number): Promise<Server> {
  const s = createServer((req: IncomingMessage, res) => {
    seen.push({
      api: name,
      method: req.method ?? '',
      url: req.url ?? '',
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      origin: req.headers.origin,
    })
    // no Access-Control-* headers anywhere: a page cannot read any of this by itself
    if (req.url === '/redirect') {
      res.statusCode = 302
      res.setHeader('location', '/pets')
      return void res.end()
    }
    res.setHeader('content-type', 'application/json')
    res.setHeader('set-cookie', 'session=abc; Path=/')
    res.end(JSON.stringify([{ id: 1, name: `from-${name}` }]))
  })
  return new Promise((r) => s.listen(port, '127.0.0.1', () => r(s)))
}

const spec = (server: string) => ({
  openapi: '3.0.3',
  info: { title: 'Pets', version: '1' },
  servers: [{ url: server }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List pets',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'array' } } },
          },
        },
      },
      post: {
        operationId: 'createPet',
        summary: 'Create a pet',
        responses: { '200': { description: 'ok' } },
      },
    },
  },
})

let ctx: BrowserContext
let dir: string
let servers: Server[] = []
let site: Awaited<ReturnType<typeof startSite>>
let sitePort: number
let A: string
let B: string
let extensionId: string

beforeAll(async () => {
  const [pa, pb, ps] = await Promise.all([freePort(), freePort(), freePort()])
  sitePort = ps
  A = `http://a.fixture.test:${pa}`
  B = `http://b.fixture.test:${pb}`
  servers = await Promise.all([startApi('a', pa), startApi('b', pb)])
  site = await startSite(ps, { a: spec(A), b: spec(B) })
  dir = await mkdtemp(join(tmpdir(), 'sb-ext-e2e-'))
  ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--host-resolver-rules=MAP *.fixture.test 127.0.0.1',
    ],
  })
  const [sw] = ctx.serviceWorkers()
  const worker = sw ?? (await ctx.waitForEvent('serviceworker', { timeout: 20_000 }))
  extensionId = new URL(worker.url()).host
})

afterAll(async () => {
  await ctx?.close()
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  await site?.close()
  if (dir) await rm(dir, { recursive: true, force: true })
})

const SITE = () => `http://localhost:${sitePort}`

async function openOperation(origin: string, name: 'a' | 'b', key: string) {
  const page = await ctx.newPage()
  const spec = encodeURIComponent(`${origin}/__specs/${name}.json`)
  await page.goto(`${origin}/v1/?spec=${spec}`)
  await page.waitForSelector('.header .brand', { timeout: 60_000 })
  await page.evaluate((k) => {
    location.hash = `#/op/${encodeURIComponent(k)}`
  }, key)
  await page.waitForSelector('.request-panel .rq-bar', { timeout: 30_000 })
  await page
    .locator('.header-controls label.row', { hasText: 'Environment' })
    .locator('select')
    .selectOption('live')
  return page
}

/** One call to the extension as the page's own script would make it, bypassing the viewer's UI. */
function wire(
  page: Page,
  call: unknown,
  ms = 10_000,
): Promise<{ type: string; code?: string; res?: { status: number } }> {
  return page.evaluate(
    ([c, t]) =>
      new Promise((resolve) => {
        const on = (e: MessageEvent) => {
          // the viewer makes calls of its own: take only the reply to this one
          const want = (c as { id?: string }).id
          const r = e.data?.reply
          if (
            e.source === window &&
            e.data?.channel === 'specbook:reply' &&
            (want === undefined ? r?.type === 'pong' : r?.id === want)
          ) {
            removeEventListener('message', on)
            resolve(r)
          }
        }
        addEventListener('message', on)
        postMessage({ channel: 'specbook:call', call: c }, '*')
        setTimeout(() => resolve({ type: 'timeout' }), t as number)
      }),
    [call, ms] as const,
  )
}

const get = (origin: string, id: string, path = '/pets') => ({
  v: 1,
  type: 'fetch',
  id,
  req: { method: 'GET', url: `${origin}${path}`, headers: {} },
})

/** Allows the origins a site asked for, in the extension's own window, the way a person does. */
async function allowInPopup(trigger: () => Promise<void>) {
  const popup = ctx.waitForEvent('page', { timeout: 15_000 })
  await trigger()
  const p = await popup
  expect(p.url()).toContain(`chrome-extension://${extensionId}/popup.html`)
  const closed = p.waitForEvent('close', { timeout: 15_000 })
  await p.getByRole('button', { name: 'Allow' }).first().click()
  await closed
}

/** the part of the extension's `chrome` object the popup test reaches for */
interface ChromeStorage {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
    }
  }
}

describe('a page whose API sends no CORS headers', () => {
  let page: Page

  it('cannot call it by itself, and the extension is there', async () => {
    page = await openOperation(SITE(), 'a', 'pets/ListPets')
    const direct = await page.evaluate(async (u) => {
      try {
        await fetch(`${u}/pets`)
        return 'ok'
      } catch (e) {
        return String(e)
      }
    }, A)
    expect(direct).toMatch(/Failed to fetch/)
    expect(await wire(page, { v: 1, type: 'ping' })).toMatchObject({ type: 'pong', version: 1 })
  })

  it('says nothing until a call fails, then asks in the failed response, and never offers an install', async () => {
    expect(await page.locator('.ext-nudge').count()).toBe(0)
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.ext-nudge button:has-text("Allow")', { timeout: 30_000 })
    const text = await page.locator('.ext-nudge').innerText()
    expect(text).toContain('has not been allowed to call')
    expect(text).not.toContain('Get the extension')
  })

  it('is refused until the person allows it, then the call goes through without cookies', async () => {
    expect(await wire(page, get(A, 'before'))).toMatchObject({ type: 'error', code: 'not-allowed' })
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.ext-nudge button:has-text("Allow")', { timeout: 20_000 })

    await allowInPopup(() => page.locator('.ext-nudge button:has-text("Allow")').click())
    await page.bringToFront()
    // the bar updates when the person comes back to the tab
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.result-chip:has-text("200")', { timeout: 30_000 })
    await page.waitForFunction(() => document.body.innerText.includes('from-a'))

    const call = seen.filter((s) => s.api === 'a').at(-1)
    expect(call?.cookie).toBeUndefined()
    // the API sets a cookie; it does not come back on the next call
    await wire(page, get(A, 'again'))
    expect(seen.filter((s) => s.api === 'a').at(-1)?.cookie).toBeUndefined()
  })

  it('does not extend the allow to another site, or to another API', async () => {
    const other = await openOperation(`http://127.0.0.1:${sitePort}`, 'a', 'pets/ListPets')
    expect(await wire(other, get(A, 'o1'))).toMatchObject({ type: 'error', code: 'not-allowed' })
    await other.close()

    expect(await wire(page, get(B, 'b1'))).toMatchObject({ type: 'error', code: 'not-allowed' })
    expect(seen.some((s) => s.api === 'b')).toBe(false)
  })

  it('refuses a change until the person turns changes on', async () => {
    const post = {
      v: 1,
      type: 'fetch',
      id: 'w1',
      req: { method: 'POST', url: `${A}/pets`, headers: {}, body: { kind: 'text', text: '{}' } },
    }
    expect(await wire(page, post)).toMatchObject({ type: 'error', code: 'read-only' })
    expect(seen.some((s) => s.method === 'POST')).toBe(false)

    const popup = await ctx.newPage()
    await popup.goto(
      `chrome-extension://${extensionId}/popup.html?site=${encodeURIComponent(SITE())}`,
    )
    // the window says what the switch means
    await popup
      .getByText('Modify data lets it send POST, PUT, PATCH and DELETE')
      .waitFor({ timeout: 10_000 })
    await popup
      .getByRole('checkbox', { name: /Modify data/ })
      .first()
      .check()
    await popup.close()
    expect(await wire(page, post)).toMatchObject({ type: 'response', res: { status: 200 } })
    expect(seen.some((s) => s.method === 'POST')).toBe(true)
  })

  it('a refused change gives the person a button that asks, and the change goes through once allowed', async () => {
    // changes were allowed above, and stay allowed until the API is revoked: the switch is locked on
    const manage = await ctx.newPage()
    await manage.goto(
      `chrome-extension://${extensionId}/popup.html?site=${encodeURIComponent(SITE())}`,
    )
    const locked = manage.getByRole('checkbox', { name: /Modify data/ }).first()
    await locked.waitFor({ timeout: 10_000 })
    expect(await locked.isChecked()).toBe(true)
    expect(await locked.isDisabled()).toBe(true)
    // Revoke takes everything away at once, reading and changing
    await manage.getByRole('button', { name: 'Revoke' }).first().click()
    await manage.getByText('None yet.').waitFor({ timeout: 10_000 })
    await manage.close()
    const postsBefore = seen.filter((s) => s.method === 'POST').length

    await page.evaluate(() => {
      location.hash = `#/op/${encodeURIComponent('pets/CreatePet')}`
    })
    await page.waitForSelector('.request-panel .rq-bar', { timeout: 30_000 })
    // revoked, so the first call is refused as not allowed at all; allow reading first
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.ext-nudge button:has-text("Allow")', { timeout: 30_000 })
    await allowInPopup(() => page.locator('.ext-nudge button:has-text("Allow")').click())
    await page.bringToFront()
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.ext-nudge button:has-text("Allow modifying data")', {
      timeout: 30_000,
    })
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(postsBefore)

    const popup = ctx.waitForEvent('page', { timeout: 15_000 })
    await page.locator('.ext-nudge button:has-text("Allow modifying data")').click()
    const p = await popup
    expect(p.url()).toContain('writes=1')
    const closed = p.waitForEvent('close', { timeout: 15_000 })
    // the highlighted row is the one being asked about
    await p
      .locator('.row.asking')
      .getByRole('checkbox', { name: /Modify data/ })
      .click()
    await closed

    await page.bringToFront()
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.result-chip:has-text("200")', { timeout: 30_000 })
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(postsBefore + 1)
  })

  it('on a phone-sized window the response panel fits, and asking, reading and changing all work', async () => {
    // the viewer drops its environment select on a phone, so pick live at full width, then narrow the window
    const phone = await openOperation(SITE(), 'b', 'pets/ListPets')
    await phone.setViewportSize({ width: 390, height: 844 })
    const fits = async (selector: string) => {
      const box = await phone.locator(selector).first().boundingBox()
      expect(box, selector).not.toBeNull()
      expect(box?.x, `${selector} left edge`).toBeGreaterThanOrEqual(0)
      expect((box?.x ?? 0) + (box?.width ?? 0), `${selector} right edge`).toBeLessThanOrEqual(390)
    }
    const noSidewaysScroll = async () =>
      expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      )

    // not allowed yet: the note and its button sit inside the response
    await phone.getByRole('button', { name: 'Send' }).click()
    await phone.waitForSelector('.ext-nudge button:has-text("Allow")', { timeout: 30_000 })
    await fits('.ext-nudge')
    await fits('.ext-nudge button')
    await noSidewaysScroll()
    await allowInPopup(() => phone.locator('.ext-nudge button:has-text("Allow")').click())
    await phone.bringToFront()

    // allowed: the call goes through, and the response says so
    await phone.getByRole('button', { name: 'Send' }).click()
    await phone.waitForSelector('.result-chip:has-text("200")', { timeout: 30_000 })
    await phone.getByText('via extension').waitFor({ timeout: 10_000 })
    await fits('.rs-head')
    await noSidewaysScroll()

    // a change: refused as read-only, with a button that fits and works
    await phone.evaluate(() => {
      location.hash = `#/op/${encodeURIComponent('pets/CreatePet')}`
    })
    await phone.waitForSelector('.request-panel .rq-bar', { timeout: 30_000 })
    await phone.getByRole('button', { name: 'Send' }).click()
    await phone.waitForSelector('.ext-nudge button:has-text("Allow modifying data")', {
      timeout: 30_000,
    })
    await fits('.ext-nudge')
    await fits('.ext-nudge button')
    await noSidewaysScroll()
    const popup = ctx.waitForEvent('page', { timeout: 15_000 })
    await phone.locator('.ext-nudge button:has-text("Allow modifying data")').click()
    const win = await popup
    const closed = win.waitForEvent('close', { timeout: 15_000 })
    // the highlighted row is the one being asked about
    await win
      .locator('.row.asking')
      .getByRole('checkbox', { name: /Modify data/ })
      .click()
    await closed
    await phone.bringToFront()
    await phone.getByRole('button', { name: 'Send' }).click()
    await phone.waitForSelector('.result-chip:has-text("200")', { timeout: 30_000 })
    await phone.close()
  })

  it('reading and changing can be allowed in one answer, with no second question', async () => {
    // start from nothing allowed for this site
    const manage = await ctx.newPage()
    await manage.goto(
      `chrome-extension://${extensionId}/popup.html?site=${encodeURIComponent(SITE())}`,
    )
    // other tests allowed more than one API for this site: take them all away
    const revokes = manage.getByRole('button', { name: 'Revoke' })
    for (let left = await revokes.count(); left > 0; left = await revokes.count()) {
      await revokes.first().click()
      // the window redraws once the grant is gone
      await manage.waitForFunction(
        (was) =>
          [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Revoke')
            .length < was,
        left,
      )
    }
    await manage.getByText('None yet.').waitFor({ timeout: 10_000 })
    await manage.close()
    const postsBefore = seen.filter((s) => s.method === 'POST').length

    await page.evaluate(() => {
      location.hash = `#/op/${encodeURIComponent('pets/CreatePet')}`
    })
    await page.waitForSelector('.request-panel .rq-bar', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.ext-nudge button:has-text("Allow")', { timeout: 30_000 })

    // the highlighted row has its own Modify data box: tick it and answer once
    const asked = ctx.waitForEvent('page', { timeout: 15_000 })
    await page.locator('.ext-nudge button:has-text("Allow")').click()
    const win = await asked
    const closed = win.waitForEvent('close', { timeout: 15_000 })
    const row = win.locator('.row.asking')
    await row.getByRole('checkbox', { name: /Modify data/ }).check()
    await row.getByRole('button', { name: 'Allow' }).click()
    await closed

    // the change goes straight through: no read-only refusal in between
    await page.bringToFront()
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForSelector('.result-chip:has-text("200")', { timeout: 30_000 })
    expect(await page.locator('.ext-nudge').count()).toBe(0)
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(postsBefore + 1)
  })

  it('reports a redirect instead of following it', async () => {
    expect(await wire(page, get(A, 'r1', '/redirect'))).toMatchObject({
      type: 'error',
      code: 'redirect',
    })
    expect(seen.filter((s) => s.url === '/pets').length).toBeGreaterThan(0)
  })

  it('limits how fast a page can call one API', async () => {
    const codes: string[] = []
    for (let i = 0; i < 40; i++) {
      const r = await wire(page, get(A, `rl${i}`))
      codes.push(r.type === 'error' ? (r.code ?? 'error') : 'ok')
    }
    expect(codes).toContain('rate-limited')
    expect(codes[0]).toBe('ok')
  })

  it('asking about a private address offers Allow private in the same answer, and a public one does not', async () => {
    // the fixture server also answers on its loopback address, which is a private one
    const priv = `http://127.0.0.1:${new URL(A).port}`
    const publicOnly = 'http://c.fixture.test:9'
    expect(await wire(page, get(priv, 'pv0'))).toMatchObject({ type: 'error' })

    const popup = await ctx.newPage()
    await popup.goto(
      `chrome-extension://${extensionId}/popup.html?site=${encodeURIComponent(SITE())}&need=${encodeURIComponent(`${priv},${publicOnly}`)}`,
    )
    const privRow = popup.locator('.row.asking', { hasText: '127.0.0.1' })
    const pubRow = popup.locator('.row.asking', { hasText: 'c.fixture.test' })
    await privRow.getByRole('button', { name: 'Allow' }).waitFor({ timeout: 10_000 })
    expect(await privRow.getByRole('checkbox', { name: /Modify data/ }).count()).toBe(1)
    expect(await privRow.getByRole('checkbox', { name: /Allow private/ }).count()).toBe(1)
    expect(await pubRow.getByRole('checkbox', { name: /Modify data/ }).count()).toBe(1)
    expect(await pubRow.getByRole('checkbox', { name: /Allow private/ }).count()).toBe(0)
    // like Modify data, it is offered and off: a person opts in to reaching a private address
    expect(await privRow.getByRole('checkbox', { name: /Allow private/ }).isChecked()).toBe(false)

    // one answer: read the API and reach a private address
    await privRow.getByRole('checkbox', { name: /Allow private/ }).check()
    await privRow.getByRole('button', { name: 'Allow' }).click()
    await popup
      .locator('.row.api:not(.asking)', { hasText: '127.0.0.1' })
      .waitFor({ timeout: 10_000 })
    expect(await wire(page, get(priv, 'pv1'))).toMatchObject({
      type: 'response',
      res: { status: 200 },
    })
    // the grant shows both of its switches, Allow private already on
    const granted = popup.locator('.row.api:not(.asking)', { hasText: '127.0.0.1' })
    expect(await granted.getByRole('checkbox', { name: /Allow private/ }).isChecked()).toBe(true)

    await granted.getByRole('button', { name: 'Revoke' }).click()
    await granted.waitFor({ state: 'detached', timeout: 10_000 })
    await popup.close()
  })

  it('a row of the popup with every control keeps Revoke beside the name, and the window does not grow sideways', async () => {
    const popup = await ctx.newPage()
    const url = `chrome-extension://${extensionId}/popup.html?site=${encodeURIComponent(SITE())}`
    await popup.goto(url)
    // a private address has both switches (Modify data and Allow private), which is the widest row there is
    const api = 'http://192.168.100.200:12345'
    await popup.evaluate(
      async ([site, origin]) => {
        const chrome = (globalThis as unknown as { chrome: ChromeStorage }).chrome
        const got = (await chrome.storage.local.get('grants')) as {
          grants?: Record<string, object>
        }
        await chrome.storage.local.set({
          grants: {
            ...got.grants,
            [site as string]: {
              ...(got.grants?.[site as string] ?? {}),
              [origin as string]: { writes: true, private: true, at: Date.now() },
            },
          },
        })
      },
      [SITE(), api],
    )
    try {
      await popup.goto(url)
      const row = popup.locator('.row', { hasText: '192.168.100.200:12345' })
      await row.getByRole('button', { name: 'Revoke' }).waitFor({ timeout: 10_000 })
      const lay = await popup.evaluate(() => {
        const row = [...document.querySelectorAll('.row')].find((r) =>
          r.textContent?.includes('192.168.100.200'),
        ) as Element
        const box = (el: Element | null) => (el as Element).getBoundingClientRect()
        const revoke = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Revoke')
        return {
          name: box(row.querySelector('.grow')),
          revoke: box(revoke ?? null),
          switches: [...row.querySelectorAll('label')].map((l) => box(l)),
          sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }
      })
      // Revoke is on the line of the name, and the switches are together on a line of their own below
      expect(lay.revoke.top).toBeLessThan(lay.name.bottom)
      expect(lay.switches).toHaveLength(2)
      for (const sw of lay.switches) expect(sw.top).toBeGreaterThanOrEqual(lay.name.bottom - 1)
      expect(Math.abs((lay.switches[0]?.top ?? 0) - (lay.switches[1]?.top ?? 1))).toBeLessThan(2)
      expect(lay.sideways).toBeLessThanOrEqual(0)
    } finally {
      await popup.evaluate(
        async ([site, origin]) => {
          const chrome = (globalThis as unknown as { chrome: ChromeStorage }).chrome
          const got = (await chrome.storage.local.get('grants')) as {
            grants?: Record<string, Record<string, object>>
          }
          const mine = { ...(got.grants?.[site as string] ?? {}) }
          delete mine[origin as string]
          await chrome.storage.local.set({ grants: { ...got.grants, [site as string]: mine } })
        },
        [SITE(), api],
      )
      await popup.close()
    }
  })
})
