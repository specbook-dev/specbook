import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { freePort, openOperation, startPreview, startSite, storedFor } from './harness'
import {
  CLIENT_ID,
  createRealm,
  IMPLICIT_CLIENT_ID,
  type Keycloak,
  NO_CORS_CLIENT_ID,
  reachable,
  USER,
} from './provision'
import {
  IMPLICIT_KEY,
  IMPLICIT_SECRET,
  keycloakSpecs,
  OAUTH_KEY,
  OAUTH_SECRET,
  OIDC_KEY,
  OIDC_SECRET,
} from './specs'

/**
 * Sign-in against a real Keycloak, through the real UI in a real browser: the popup, the redirect back, the
 * hand-off to the opening tab, and the token exchange (through the dev server's proxy on one pass, straight
 * from the page on the other). Start Keycloak with `test/oauth/keycloak.sh up`; `pnpm test:oauth` runs this.
 */

const kc: Keycloak = {
  url: process.env.KEYCLOAK_URL ?? `http://127.0.0.1:${process.env.KEYCLOAK_PORT ?? '8080'}`,
  realm: 'specbook-test',
  adminUser: process.env.KEYCLOAK_ADMIN ?? 'admin',
  adminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin',
}
const kcOrigin = new URL(kc.url).origin

let browser: Browser
let dir: string
let site: Awaited<ReturnType<typeof startSite>>
const previews: Record<
  'oauth' | 'oidc' | 'implicit',
  Awaited<ReturnType<typeof startPreview>>
> = {} as never

beforeAll(async () => {
  if (!(await reachable(kc.url)))
    throw new Error(
      `No Keycloak at ${kc.url}. Start one with packages/ui/test/oauth/keycloak.sh up ` +
        '(or set KEYCLOAK_URL), then run this again.',
    )
  const [sitePort, oauthPort, oidcPort, implicitPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ])
  const origins = [sitePort, oauthPort, oidcPort, implicitPort].map((p) => `http://localhost:${p}`)
  await createRealm(kc, origins)

  const specs = keycloakSpecs(kc)
  dir = await mkdtemp(join(tmpdir(), 'sb-oauth-specs-'))
  const files = {
    oauth: join(dir, 'oauth.json'),
    oidc: join(dir, 'oidc.json'),
    implicit: join(dir, 'implicit.json'),
  }
  await writeFile(files.oauth, JSON.stringify(specs.oauth))
  await writeFile(files.oidc, JSON.stringify(specs.oidc))
  await writeFile(files.implicit, JSON.stringify(specs.implicit))

  site = await startSite(sitePort, specs)
  ;[previews.oauth, previews.oidc, previews.implicit] = await Promise.all([
    startPreview(files.oauth, oauthPort),
    startPreview(files.oidc, oidcPort),
    startPreview(files.implicit, implicitPort),
  ])
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  await Promise.all([
    previews.oauth?.close(),
    previews.oidc?.close(),
    previews.implicit?.close(),
    site?.close(),
  ])
  if (dir) await rm(dir, { recursive: true, force: true })
})

// Keycloak sets an SSO cookie: a context reused between tests would skip the password form
const contexts: BrowserContext[] = []
const fresh = async () => {
  const c = await browser.newContext()
  contexts.push(c)
  return c
}
afterEach(async ({ task }) => {
  // what the person would have seen, including a provider's own error page left open in the popup
  if (task.result?.state === 'fail') {
    const out = resolve(import.meta.dirname, '../../.vitest/oauth')
    await mkdir(out, { recursive: true })
    const slug = task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
    const pages = contexts.flatMap((c) => c.pages())
    await Promise.all(
      pages.map((p, i) =>
        p.screenshot({ path: join(out, `${slug}-${i}.png`) }).catch(() => undefined),
      ),
    )
  }
  await Promise.all(contexts.splice(0).map((c) => c.close()))
})

const clientField = (page: Page) => page.getByLabel(/Client id for/)
const signInButton = (page: Page) => page.getByRole('button', { name: 'Sign in' })

/** Fills the client id and clicks Sign in; resolves with the popup the page opened. */
async function startSignIn(page: Page, clientId: string) {
  await signInButton(page).waitFor({ state: 'visible', timeout: 30_000 })
  await vi.waitFor(async () => expect(await signInButton(page).isEnabled()).toBe(true), {
    timeout: 30_000,
  })
  await clientField(page).fill(clientId)
  const popup = page.waitForEvent('popup')
  await signInButton(page).click()
  return popup
}

/** Logs in on Keycloak's page and waits for the popup to be closed by the page's own hand-off. */
async function login(popup: Page) {
  await popup.waitForURL(/\/protocol\/openid-connect\/auth/, { timeout: 60_000 })
  await popup.locator('#username').fill(USER.username)
  await popup.locator('#password').fill(USER.password)
  const closed = popup.waitForEvent('close', { timeout: 60_000 })
  await popup.locator('#kc-login').click()
  await closed
}

/** What the page sent the provider, read from the address of the popup it opened. */
function expectAuthorizationRequest(popup: Page, page: Page, pass: 'dev' | 'static') {
  const here = new URL(page.url())
  const q = new URL(popup.url()).searchParams
  expect(q.get('response_type')).toBe('code')
  expect(q.get('client_id')).toBe(CLIENT_ID)
  // the hosted site registers one unversioned callback page; the dev server's page is its own address
  expect(q.get('redirect_uri')).toBe(
    pass === 'static' ? `${here.origin}/oauth/callback/` : `${here.origin}${here.pathname}`,
  )
  expect(q.get('scope')?.split(' ')).toContain('openid')
  // PKCE with S256: a challenge is a SHA-256 digest, 43 characters of base64url; a state is not guessable
  expect(q.get('code_challenge_method')).toBe('S256')
  expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/)
  // nothing a browser must not hold, and nothing only the exchange should carry
  expect(q.has('client_secret')).toBe(false)
  expect(q.has('code_verifier')).toBe(false)
}

async function expectSignedIn(page: Page, secret: string, visited: string[]) {
  await page.locator('.secrets-chip').waitFor({ state: 'visible', timeout: 30_000 })
  const { token, local } = await storedFor(page, kcOrigin, secret)
  // bound to the API's origin, under the scheme's name, for this tab only
  expect(token, 'the token is held for the API origin').toBeTruthy()
  expect(local).not.toContain(token as string)
  // neither the opener's address nor its navigations ever carried the code, the state or the token
  const seen = [...visited, page.url()].join('\n')
  expect(seen).not.toMatch(/[?&#](code|state|access_token)=/)
  expect(seen).not.toContain(token as string)
}

async function callApi(page: Page) {
  await page.getByRole('button', { name: 'Send' }).click()
  await page.waitForSelector('.result-chip:has-text("200")', { timeout: 30_000 })
  // userinfo answers with the user's claims; `sub` is always among them
  await page.waitForFunction(() => /"sub"\s*:/.test(document.body.innerText), undefined, {
    timeout: 30_000,
  })
}

for (const pass of ['dev', 'static'] as const) {
  const urlFor = (kind: 'oauth' | 'oidc' | 'implicit') =>
    pass === 'dev' ? previews[kind].url : site.viewerUrl(kind)

  describe(`${pass === 'dev' ? 'the dev server (token exchange through its proxy)' : 'the static viewer (token exchange straight from the page)'}`, () => {
    it('signs in with an OAuth 2.0 scheme, calls the API with the token, and keeps it in this tab only', async () => {
      const ctx = await fresh()
      const { page, errors, visited } = await openOperation(ctx, urlFor('oauth'), OAUTH_KEY)
      const popup = await startSignIn(page, CLIENT_ID)
      await popup.waitForURL(/\/protocol\/openid-connect\/auth/, { timeout: 60_000 })
      expectAuthorizationRequest(popup, page, pass)
      await login(popup)
      await expectSignedIn(page, OAUTH_SECRET, visited)
      await callApi(page)
      expect(errors).toEqual([])

      // a reload keeps it (sessionStorage is the tab's); a new tab does not have it
      const other = await ctx.newPage()
      await other.goto(urlFor('oauth'))
      await other.waitForSelector('.header .brand', { timeout: 60_000 })
      expect((await storedFor(other, kcOrigin, OAUTH_SECRET)).token).toBeUndefined()
    })

    it('signs in with an OpenID Connect scheme, finding the endpoints from the discovery document', async () => {
      // static pass: if this is the one that fails, check whether Keycloak sends CORS headers for its
      // discovery document to a registered web origin; the page's message should then say CORS
      const ctx = await fresh()
      const { page, visited } = await openOperation(ctx, urlFor('oidc'), OIDC_KEY)
      await login(await startSignIn(page, CLIENT_ID))
      await expectSignedIn(page, OIDC_SECRET, visited)
      await callApi(page)
    })

    it('signs in with the implicit flow: the token arrives in the address fragment and never reaches a server', async () => {
      const ctx = await fresh()
      const requested: string[] = []
      ctx.on('request', (r) => requested.push(r.url()))
      const { page, visited } = await openOperation(ctx, urlFor('implicit'), IMPLICIT_KEY)
      const popup = await startSignIn(page, IMPLICIT_CLIENT_ID)
      await popup.waitForURL(/\/protocol\/openid-connect\/auth/, { timeout: 60_000 })
      const q = new URL(popup.url()).searchParams
      expect(q.get('response_type')).toBe('token')
      // no code to protect, so no challenge
      expect(q.has('code_challenge')).toBe(false)
      expect(q.has('client_secret')).toBe(false)
      await login(popup)
      await expectSignedIn(page, IMPLICIT_SECRET, visited)
      await callApi(page)
      const { token } = await storedFor(page, kcOrigin, IMPLICIT_SECRET)
      // the token travelled in a fragment: no request URL (the dev server's included) carries it
      expect(requested.filter((u) => u.includes(token as string))).toEqual([])
    })

    it('shows Keycloak’s own error for an unknown client, and Cancel leaves the prompt usable', async () => {
      const ctx = await fresh()
      const { page, visited } = await openOperation(ctx, urlFor('oauth'), OAUTH_KEY)
      const popup = await startSignIn(page, 'no-such-client')
      await popup.waitForURL(/\/protocol\/openid-connect\/auth/, { timeout: 60_000 })

      // Keycloak does not redirect back for this: the page keeps waiting, the popup stays open
      await page.getByText('Waiting for the sign-in window').waitFor({ timeout: 10_000 })
      await new Promise((r) => setTimeout(r, 1_500))
      expect(popup.isClosed()).toBe(false)

      await page.getByRole('button', { name: 'Cancel' }).click()
      await page.getByText('Sign-in was cancelled.').waitFor({ timeout: 10_000 })
      await vi.waitFor(() => expect(popup.isClosed()).toBe(true))
      expect(await page.locator('input[type="password"]').isVisible()).toBe(true)

      // and the same page signs in afterwards
      await login(await startSignIn(page, CLIENT_ID))
      await expectSignedIn(page, OAUTH_SECRET, visited)
    })
  })
}

describe('the static viewer, when the provider will not talk to this page', () => {
  it('says the sign-in server refused the browser (CORS), and paste still works', async () => {
    const ctx = await fresh()
    const { page } = await openOperation(ctx, site.viewerUrl('oauth'), OAUTH_KEY)
    // a client with no web origins: Keycloak logs the person in, then its token endpoint answers no browser
    await login(await startSignIn(page, NO_CORS_CLIENT_ID))
    await page
      .getByText(/does not allow calls from this page \(CORS\)/)
      .waitFor({ state: 'visible', timeout: 30_000 })
    expect((await storedFor(page, kcOrigin, OAUTH_SECRET)).token).toBeUndefined()
    expect(await page.locator('input[type="password"]').isVisible()).toBe(true)
  })
})

describe('the realm the suite signs in to', () => {
  // The sign-in cases above pass because the page sends a challenge. Without this one they would pass
  // just as well if the realm's PKCE setting were silently ignored, and they would prove nothing about it.
  it('refuses an authorization request with no PKCE challenge, or with a plain one', async () => {
    const redirectUri = `${new URL(site.viewerUrl('oauth')).origin}/oauth/callback/`
    const ask = async (extra: Record<string, string>) => {
      const url = new URL(`${kc.url}/realms/${kc.realm}/protocol/openid-connect/auth`)
      const params = {
        client_id: CLIENT_ID,
        response_type: 'code',
        scope: 'openid',
        state: 'a-state-the-test-chose',
        redirect_uri: redirectUri,
        ...extra,
      }
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
      // `manual`: Node reports the redirect itself instead of following it to the page
      const r = await fetch(url, { redirect: 'manual' })
      return { status: r.status, location: r.headers.get('location') ?? '', body: await r.text() }
    }
    const showsLogin = (r: Awaited<ReturnType<typeof ask>>) =>
      r.status === 200 && /name="username"|id="username"/.test(r.body)
    // the RFC 7636 appendix B challenge: any well-formed one will do
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

    // control: a proper S256 request gets the login form, so a refusal below is about PKCE and nothing else
    const good = await ask({ code_challenge: challenge, code_challenge_method: 'S256' })
    expect(showsLogin(good), `control request answered ${good.status}`).toBe(true)

    const refused: Record<string, string>[] = [
      {},
      { code_challenge: challenge, code_challenge_method: 'plain' },
    ]
    for (const extra of refused) {
      const r = await ask(extra)
      expect(showsLogin(r), `${JSON.stringify(extra)} was offered a login`).toBe(false)
      // an error redirect back to the page, or an error page: never a form to log in with
      if (r.status >= 300 && r.status < 400) expect(r.location).toMatch(/[?&]error=/)
      else expect(r.status).toBeGreaterThanOrEqual(400)
    }
  })
})

describe('the dev server’s proxy', () => {
  it('forwards a sign-in only to a profile the project declared', async () => {
    const r = await fetch(`${previews.oauth.url}__specbook/proxy/live/auth:not-declared/x`, {
      method: 'POST',
      body: 'a=b',
    })
    expect(r.status).toBe(404)
  })
})
