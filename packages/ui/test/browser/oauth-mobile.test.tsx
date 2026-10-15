import type { SpecbookConfig } from '@specbook/core'
import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { SecretsBar } from '../../src/panel/SecretsBar'
import { engine } from '../../src/runtime'
import { env } from '../../src/store'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

const API = 'https://api.example.com'
// the long, unbroken strings a real provider produces
const AUTHORIZE = 'https://login.example-identity-provider.com/oauth2/v2.0/authorize'
const SCOPES = {
  openid: '',
  'https://www.googleapis.com/auth/userinfo.profile': '',
  'https://www.googleapis.com/auth/userinfo.email': '',
  'read:orders': '',
  'write:orders': '',
}

const config = {
  project: 'p',
  services: { shop: { spec: '', baseUrl: { live: `${API}/v1` }, auth: 'shopAuth' } },
  auth: {
    shopAuth: {
      title: 'shopAuth (OAuth, sign in or paste an access token)',
      apply: { headers: { authorization: 'Bearer {{secrets.SHOPAUTH}}' } },
      oauth: { authorizationUrl: AUTHORIZE, tokenUrl: `${AUTHORIZE}/token`, scopes: SCOPES },
    },
  },
} as unknown as SpecbookConfig

describe('Sign in on a phone', () => {
  let host: HTMLElement
  let viewport: [number, number]
  beforeEach(async () => {
    host = document.body.appendChild(document.createElement('div'))
    env.value = 'live'
    viewport = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    vi.spyOn(engine, 'config').mockResolvedValue(config)
    vi.spyOn(engine, 'oauthEndpoints').mockResolvedValue({
      authorizationUrl: AUTHORIZE,
      tokenUrl: `${AUTHORIZE}/token`,
      scopes: SCOPES,
    })
    vi.spyOn(engine, 'managedSecrets').mockResolvedValue({})
  })
  afterEach(async () => {
    render(null, host)
    host.remove()
    env.value = 'mock'
    vi.restoreAllMocks()
    await page.viewport(...viewport)
  })

  const mount = async () => {
    render(
      <div class="panel">
        <div class="request-panel">
          <div class="rq">
            <SecretsBar services={['shop']} supplied={{}} />
          </div>
        </div>
      </div>,
      host,
    )
    const bar = await vi.waitFor(() => {
      const el = host.querySelector<HTMLElement>('fieldset.needs-vars')
      expect(el).not.toBeNull()
      expect(el?.querySelector('.oauth-signin')).not.toBeNull()
      return el as HTMLElement
    })
    // the endpoints have resolved: the button is live
    await vi.waitFor(() =>
      expect(
        [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Sign in')?.disabled,
      ).toBe(false),
    )
    return bar
  }

  /**
   * Every descendant stays inside the bar, which stays inside the 390px screen. Measured against the
   * panel: it slides in (a transform) for 160ms, which moves the panel and the bar together.
   */
  const staysInside = (bar: HTMLElement) => {
    const panel = (host.querySelector('.panel') as HTMLElement).getBoundingClientRect()
    const outer = bar.getBoundingClientRect()
    expect(outer.left - panel.left).toBeGreaterThanOrEqual(0)
    expect(outer.right - panel.left).toBeLessThanOrEqual(390)
    expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth)
    const strays = [...bar.querySelectorAll<HTMLElement>('*')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.right > outer.right + 0.5
      })
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}: ${el.textContent?.slice(0, 40)}`)
    expect(strays).toEqual([])
  }

  it('fits the screen, with fields and buttons big enough to tap', async () => {
    const bar = await mount()
    staysInside(bar)

    const id = bar.querySelector('input[aria-label^="Client id"]') as HTMLInputElement
    expect(parseFloat(getComputedStyle(id).fontSize)).toBeGreaterThanOrEqual(16)
    expect(id.getBoundingClientRect().height).toBeGreaterThanOrEqual(36)
    const signIn = [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Sign in')
    expect(signIn?.getBoundingClientRect().height).toBeGreaterThanOrEqual(36)
    expect(signIn?.getBoundingClientRect().width).toBeGreaterThanOrEqual(36)
    // the paste fallback is still reachable and just as usable
    const paste = bar.querySelector('input[type="password"]') as HTMLInputElement
    expect(paste.getBoundingClientRect().height).toBeGreaterThanOrEqual(36)
  })

  it('keeps the scope list inside the screen, with a target per scope', async () => {
    const bar = await mount()
    const details = bar.querySelector('details') as HTMLDetailsElement
    details.open = true
    await vi.waitFor(() => expect(details.querySelectorAll('label').length).toBe(5))
    staysInside(bar)
    for (const label of details.querySelectorAll('label'))
      expect(label.getBoundingClientRect().height).toBeGreaterThanOrEqual(24)
  })

  it('wraps a long error message instead of pushing the page wider', async () => {
    vi.mocked(engine.oauthEndpoints).mockRejectedValue(
      new Error(
        `The provider's discovery document at https://login.example-identity-provider.com/tenants/00000000-0000-0000-0000-000000000000/v2.0/.well-known/openid-configuration answered 503`,
      ),
    )
    render(
      <div class="panel">
        <div class="request-panel">
          <div class="rq">
            <SecretsBar services={['shop']} supplied={{}} />
          </div>
        </div>
      </div>,
      host,
    )
    const bar = await vi.waitFor(() => {
      const el = host.querySelector<HTMLElement>('fieldset.needs-vars')
      expect(el?.textContent).toContain('answered 503')
      return el as HTMLElement
    })
    staysInside(bar)
  })
})
