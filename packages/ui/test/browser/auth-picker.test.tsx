import type { SpecbookConfig } from '@specbook/core'
import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { setChoice } from '../../src/auth-choice'
import type { Security } from '../../src/auth-options'
import { SecretsBar } from '../../src/panel/SecretsBar'
import { engine, registry } from '../../src/runtime'
import { secretStore } from '../../src/secrets'
import { env } from '../../src/store'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

const origin = 'https://petstore3.swagger.io'
// what the Petstore spec says: GetPetById takes either, GetInventory only the key, AddPet only the sign-in
const either: Security = [{ api_key: [] }, { petstore_auth: ['write:pets', 'read:pets'] }]
const onlyKey: Security = [{ api_key: [] }]
const onlyOauth: Security = [{ petstore_auth: ['write:pets', 'read:pets'] }]

describe('choosing how to authenticate', () => {
  let host: HTMLElement
  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'))
    env.value = 'live'
  })
  afterEach(() => {
    render(null, host)
    host.remove()
    env.value = 'mock'
    setChoice('petstore', undefined)
    for (const n of ['PETSTORE_API_KEY', 'PETSTORE_AUTH']) secretStore.remove(origin, n)
    vi.restoreAllMocks()
  })

  const mount = (securities: Security[]) =>
    render(
      <SecretsBar services={['petstore']} securities={{ petstore: securities }} supplied={{}} />,
      host,
    )
  const radios = () => [...host.querySelectorAll<HTMLLabelElement>('label.auth-opt')]
  const checked = () => radios().map((r) => r.querySelector('input')?.checked)
  const label = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim()

  it('offers every way the operation accepts, the cheapest chosen, and each says what it still needs', async () => {
    mount([either])
    await vi.waitFor(() => expect(radios()).toHaveLength(2))
    expect(radios().map(label)).toEqual(['API key paste', 'OAuth sign-in sign in'])
    expect(checked()).toEqual([true, false])
    // the chosen way asks for its own secret and nobody else's
    expect(host.querySelector('input[aria-label="PETSTORE_API_KEY for petstore"]')).not.toBeNull()
    expect(host.querySelector('input[aria-label="PETSTORE_AUTH for petstore"]')).toBeNull()
  })

  it('switches to the other way on a tap, and keeps the choice for this tab', async () => {
    mount([either])
    await vi.waitFor(() => expect(radios()).toHaveLength(2))
    radios()[1]?.querySelector('input')?.click()
    await vi.waitFor(() =>
      expect(host.querySelector('input[aria-label="PETSTORE_AUTH for petstore"]')).not.toBeNull(),
    )
    expect(checked()).toEqual([false, true])
    expect(host.querySelector('input[aria-label="PETSTORE_API_KEY for petstore"]')).toBeNull()
    // a sign-in is offered beside the paste field
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Sign in')).toBe(true)
    expect(JSON.parse(sessionStorage.getItem('specbook.auth.v1') ?? '{}')).toEqual({
      petstore: 'petstore-auth',
    })
  })

  it('shows a ready way as ready', async () => {
    secretStore.set(origin, 'PETSTORE_API_KEY', 'k')
    mount([either])
    // the key is set, so nothing is missing: the bar folds to a chip naming it
    await vi.waitFor(() => expect(host.querySelector('.secrets-chip')).not.toBeNull())
    expect(host.querySelector('.secrets-chip')?.textContent).toContain('API key')
    ;(host.querySelector('.secrets-chip') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(radios()).toHaveLength(2))
    expect(label(radios()[0] as Element)).toBe('API key ✓')
  })

  it('says so when an operation accepts only one way, and offers no choice', async () => {
    mount([onlyKey])
    await vi.waitFor(() => expect(host.textContent).toContain('Accepts only api_key.'))
    expect(radios()).toHaveLength(0)
    expect(host.querySelector('input[aria-label="PETSTORE_API_KEY for petstore"]')).not.toBeNull()
  })

  it('uses the way an operation accepts even when another is chosen', async () => {
    setChoice('petstore', 'petstore')
    mount([onlyOauth])
    await vi.waitFor(() => expect(host.textContent).toContain('Accepts only petstore_auth.'))
    expect(radios()).toHaveLength(0)
    expect(host.querySelector('input[aria-label="PETSTORE_AUTH for petstore"]')).not.toBeNull()
  })

  it('asks for a way for each kind of step in a flow, with no choice between them', async () => {
    mount([onlyKey, onlyOauth])
    await vi.waitFor(() =>
      expect(host.querySelector('input[aria-label="PETSTORE_AUTH for petstore"]')).not.toBeNull(),
    )
    expect(host.querySelector('input[aria-label="PETSTORE_API_KEY for petstore"]')).not.toBeNull()
    expect(radios()).toHaveLength(0)
  })

  it('says when the spec wants something no profile of the service supplies', async () => {
    mount([[{ somethingElse: [] }]])
    await vi.waitFor(() => expect(host.textContent).toContain('The spec wants somethingElse'))
    // the default is still tried, and still asked for
    expect(host.querySelector('input[aria-label="PETSTORE_API_KEY for petstore"]')).not.toBeNull()
  })

  it('fits a phone: each way on a row of its own, big enough to tap, inside the panel', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    try {
      render(
        <div class="panel">
          <div class="request-panel">
            <div class="rq">
              <SecretsBar
                services={['petstore']}
                securities={{ petstore: [either] }}
                supplied={{}}
              />
            </div>
          </div>
        </div>,
        host,
      )
      await vi.waitFor(() => expect(radios()).toHaveLength(2))
      const bar = host.querySelector('fieldset.needs-vars') as HTMLElement
      const panel = (host.querySelector('.panel') as HTMLElement).getBoundingClientRect()
      const outer = bar.getBoundingClientRect()
      expect(outer.left - panel.left).toBeGreaterThanOrEqual(0)
      expect(outer.right - panel.left).toBeLessThanOrEqual(390)
      expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth)
      const [a, b] = radios().map((r) => r.getBoundingClientRect()) as [DOMRect, DOMRect]
      for (const r of [a, b]) {
        expect(r.height).toBeGreaterThanOrEqual(40)
        expect(r.width).toBeGreaterThanOrEqual(44)
        expect(r.right).toBeLessThanOrEqual(outer.right + 0.5)
      }
      // one under the other, not side by side
      expect(b.top).toBeGreaterThanOrEqual(a.bottom - 1)
      const input = bar.querySelector('input[type="password"]') as HTMLInputElement
      expect(parseFloat(getComputedStyle(input).fontSize)).toBeGreaterThanOrEqual(16)
    } finally {
      await page.viewport(w, h)
    }
  })
})

describe('a profile only a server may hold', () => {
  let host: HTMLElement
  const config = {
    project: 'p',
    services: {
      shop: {
        spec: '',
        baseUrl: { live: 'https://api.example.com/v1' },
        auth: ['key', 'service'],
      },
    },
    auth: {
      key: { title: 'API key', apply: { headers: { 'x-key': '{{secrets.SHOP_KEY}}' } } },
      service: {
        title: 'OAuth client credentials',
        apply: { headers: { authorization: 'Bearer {{session.accessToken}}' } },
        oauth: {
          tokenUrl: 'https://idp.example.com/token',
          clientId: '{{secrets.SHOP_CLIENT_ID}}',
          clientSecret: '{{secrets.SHOP_CLIENT_SECRET}}',
        },
      },
    },
  } as unknown as SpecbookConfig
  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'))
    env.value = 'live'
    vi.spyOn(engine, 'config').mockResolvedValue(config)
    vi.spyOn(engine, 'managedSecrets').mockResolvedValue({})
  })
  afterEach(() => {
    render(null, host)
    host.remove()
    env.value = 'mock'
    setChoice('shop', undefined)
    vi.restoreAllMocks()
  })
  const radios = () => [...host.querySelectorAll<HTMLLabelElement>('label.auth-opt')]

  it('is unavailable on a page with no server, says why, and offers the way a person can use', async () => {
    vi.spyOn(engine, 'hasServer').mockReturnValue(false)
    render(<SecretsBar services={['shop']} supplied={{}} />, host)
    await vi.waitFor(() => expect(radios()).toHaveLength(2))
    radios()[1]?.querySelector('input')?.click()
    await vi.waitFor(() => expect(host.textContent).toContain('needs a server to keep it secret'))
    expect(radios()[1]?.textContent).toContain('needs a server')
    // the secrets are never asked of the page
    expect(host.querySelector('input[type="password"]')).toBeNull()
    expect(host.textContent).toContain('SHOP_CLIENT_ID, SHOP_CLIENT_SECRET')
    const use = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Use API key')
    use?.click()
    await vi.waitFor(() =>
      expect(host.querySelector('input[aria-label="SHOP_KEY for shop"]')).not.toBeNull(),
    )
  })

  it('is ready when the dev server holds the id and secret, and not before', async () => {
    vi.spyOn(engine, 'hasServer').mockReturnValue(true)
    setChoice('shop', 'service')
    render(<SecretsBar services={['shop']} supplied={{}} />, host)
    await vi.waitFor(() =>
      expect(host.textContent).toContain('held by the dev server; not set yet'),
    )
    expect(host.querySelector('input[type="password"]')).toBeNull()
    render(
      <SecretsBar
        services={['shop']}
        supplied={{ SHOP_CLIENT_ID: 'environment', SHOP_CLIENT_SECRET: 'environment' }}
      />,
      host,
    )
    await vi.waitFor(() => expect(host.querySelector('.secrets-chip')).not.toBeNull())
    expect(host.querySelector('.secrets-chip')?.textContent).toContain('OAuth client credentials')
  })
})

describe('what the Docs tab and the catalog say about credentials', () => {
  let host: HTMLElement
  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'))
  })
  afterEach(() => {
    render(null, host)
    host.remove()
  })

  it('lists the ways an operation accepts, with scopes, and the profiles of the project that work', async () => {
    const { OperationDocs } = await import('../../src/panel/OperationDocs')
    const manifest = registry.manifests.petstore?.operations.find((o) => o.id === 'GetPetById')
    expect(manifest?.security).toBeTruthy()
    render(
      <OperationDocs service="petstore" op={manifest as never} variants={[]} onTry={() => {}} />,
      host,
    )
    await vi.waitFor(() => expect(host.querySelector('.doc-auth')).not.toBeNull())
    const text = (host.querySelector('.doc-auth') as HTMLElement).textContent ?? ''
    expect(text).toContain('Send one of:')
    expect(text).toContain('api_key')
    expect(text).toContain('API key in header "api_key"')
    expect(text).toContain('petstore_auth')
    expect(text).toContain('OAuth 2.0 (implicit)')
    expect(text).toContain('with scopes write:pets, read:pets')
    await vi.waitFor(() =>
      expect(host.querySelector('.doc-auth')?.textContent).toContain(
        'In this project: API key, OAuth sign-in.',
      ),
    )
  })

  it('says an operation needs no credentials, when the document has schemes and this one does not use them', async () => {
    const { OperationDocs } = await import('../../src/panel/OperationDocs')
    const open = registry.manifests.petstore?.operations.find((o) => !o.secured)
    expect(open).toBeTruthy()
    render(
      <OperationDocs service="petstore" op={open as never} variants={[]} onTry={() => {}} />,
      host,
    )
    await vi.waitFor(() => expect(host.querySelector('.doc-auth')).not.toBeNull())
    expect(host.querySelector('.doc-auth')?.textContent).toContain('No credentials needed.')
  })

  it('names the schemes and scopes for the lock’s tooltip, from the real manifest', async () => {
    const { Catalog } = await import('../../src/components/Catalog').then((m) => ({
      Catalog: m.CatalogList,
    }))
    expect(Catalog).toBeTruthy()
    const { lockTitle } = await import('../../src/auth-describe')
    const m = registry.manifests.petstore
    const op = m?.operations.find((o) => o.id === 'GetPetById')
    expect(lockTitle(op?.security, m?.securitySchemes)).toBe(
      'Needs credentials: api_key or petstore_auth (write:pets, read:pets)',
    )
  })
})
