import { challengeFor, type SpecbookConfig } from '@specbook/core'
import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signIn } from '../../src/oauth'
import { handleOAuthCallback } from '../../src/oauth-callback'
import { SecretsBar } from '../../src/panel/SecretsBar'
import { engine } from '../../src/runtime'
import { secretStore } from '../../src/secrets'
import { env } from '../../src/store'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

const AUTHORIZE = 'https://auth.example.com/authorize'
const TOKEN = 'https://auth.example.com/oauth/token'
const API = 'https://api.example.com'

interface FakePopup {
  location: { href: string }
  closed: boolean
  close: () => void
}

/** `window.open` replaced by a popup that only remembers where it was pointed. */
function fakePopup() {
  const popup: FakePopup = { location: { href: '' }, closed: false, close: vi.fn() }
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  return { popup, open }
}

/** Plays the part of the callback page: the provider sent the person back with `extra`. */
async function comeBack(popup: FakePopup, extra: Record<string, string>, state?: string) {
  const sent = await vi.waitFor(() => {
    expect(popup.location.href).not.toBe('')
    return new URL(popup.location.href)
  })
  const channel = new BroadcastChannel('specbook-oauth')
  const acked = new Promise<boolean>((resolve) => {
    channel.onmessage = (e) => e.data?.type === 'ack' && resolve(true)
  })
  channel.postMessage({
    type: 'callback',
    state: state ?? sent.searchParams.get('state'),
    ...extra,
  })
  return { sent, acked, done: () => channel.close() }
}

describe('signIn', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens the provider with a PKCE challenge, checks state, and exchanges the code with the matching verifier', async () => {
    const { popup, open } = fakePopup()
    const exchange = vi.fn().mockResolvedValue({
      access_token: 'tok-1',
      token_type: 'Bearer',
      expires_in: 3600,
    })
    const pending = signIn({
      authorizationUrl: AUTHORIZE,
      clientId: 'cid',
      scopes: ['read', 'write'],
      exchange,
    })
    // the window is opened by the call itself, before anything is awaited
    expect(open).toHaveBeenCalledTimes(1)

    const back = await comeBack(popup, { code: 'the-code' })
    const q = back.sent.searchParams
    expect(back.sent.origin + back.sent.pathname).toBe(AUTHORIZE)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('client_id')).toBe('cid')
    expect(q.get('scope')).toBe('read write')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('redirect_uri')).toBe(`${location.origin}${location.pathname}`)

    await expect(pending).resolves.toEqual({ accessToken: 'tok-1', expiresIn: 3600 })
    await expect(back.acked).resolves.toBe(true)
    back.done()

    const fields = exchange.mock.calls[0]?.[0] as Record<string, string>
    expect(fields.grant_type).toBe('authorization_code')
    expect(fields.code).toBe('the-code')
    expect(fields.client_secret).toBeUndefined()
    // the verifier that goes to the token endpoint is the one the challenge in the URL commits to
    expect(await challengeFor(fields.code_verifier as string)).toBe(q.get('code_challenge'))
    expect(popup.close).toHaveBeenCalled()
  })

  it('ignores a return whose state is not its own, and does not exchange it', async () => {
    const { popup } = fakePopup()
    const exchange = vi.fn()
    const ctl = new AbortController()
    const pending = signIn({
      authorizationUrl: AUTHORIZE,
      clientId: 'cid',
      scopes: [],
      exchange,
      signal: ctl.signal,
    })
    const back = await comeBack(popup, { code: 'forged' }, 'someone-elses-state')
    let acked = false
    back.acked.then(() => {
      acked = true
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(acked).toBe(false)
    expect(exchange).not.toHaveBeenCalled()

    ctl.abort()
    await expect(pending).rejects.toThrow(/cancelled/)
    back.done()
  })

  it('reports what the provider refused and never calls the token endpoint', async () => {
    const { popup } = fakePopup()
    const exchange = vi.fn()
    const pending = signIn({ authorizationUrl: AUTHORIZE, clientId: 'cid', scopes: [], exchange })
    const assertion = expect(pending).rejects.toThrow(/access_denied \(nope\)/)
    const back = await comeBack(popup, { error: 'access_denied', description: 'nope' })
    await assertion
    expect(exchange).not.toHaveBeenCalled()
    back.done()
  })

  it('says so when the browser blocks the window', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    await expect(
      signIn({ authorizationUrl: AUTHORIZE, clientId: 'cid', scopes: [], exchange: vi.fn() }),
    ).rejects.toThrow(/blocked/)
  })
})

describe('the callback page', () => {
  const original = location.pathname + location.search + location.hash
  afterEach(() => history.replaceState(null, '', original))

  it('does nothing on an ordinary page load', async () => {
    await expect(handleOAuthCallback()).resolves.toBe(false)
  })

  it('hands the result to the waiting tab, strips the query, and stops the app from booting', async () => {
    history.replaceState(null, '', `${location.pathname}?code=abc&state=s-1`)
    const waiting = new BroadcastChannel('specbook-oauth')
    const seen = new Promise<Record<string, unknown>>((resolve) => {
      waiting.onmessage = (e) => {
        if (e.data?.type !== 'callback') return
        waiting.postMessage({ type: 'ack', state: e.data.state })
        resolve(e.data)
      }
    })
    const closed = vi.spyOn(window, 'close').mockImplementation(() => {})
    await expect(handleOAuthCallback()).resolves.toBe(true)
    expect(await seen).toMatchObject({ type: 'callback', state: 's-1', code: 'abc' })
    expect(location.search).toBe('')
    expect(closed).toHaveBeenCalled()
    waiting.close()
    closed.mockRestore()
  })

  it('carries on as a normal page when nobody is waiting, still removing the code from the address', async () => {
    history.replaceState(null, '', `${location.pathname}?code=abc&state=nobody`)
    await expect(handleOAuthCallback()).resolves.toBe(false)
    expect(location.search).toBe('')
  })
})

describe('Sign in beside the credentials prompt', () => {
  let host: HTMLElement
  const config = {
    project: 'p',
    services: {
      shop: { spec: '', baseUrl: { live: `${API}/v1` }, auth: 'shopAuth' },
    },
    auth: {
      shopAuth: {
        title: 'shopAuth (OAuth, sign in or paste an access token)',
        apply: { headers: { authorization: 'Bearer {{secrets.SHOPAUTH}}' } },
        oauth: {
          authorizationUrl: AUTHORIZE,
          tokenUrl: TOKEN,
          scopes: { 'read:orders': 'read orders' },
        },
      },
    },
  } as unknown as SpecbookConfig

  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'))
    env.value = 'live'
    vi.spyOn(engine, 'config').mockResolvedValue(config)
    localStorage.clear()
  })
  afterEach(() => {
    render(null, host)
    host.remove()
    env.value = 'mock'
    secretStore.remove(API, 'SHOPAUTH')
    vi.restoreAllMocks()
  })

  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === label)

  it('stores the token for the API origin, where the existing substitution finds it', async () => {
    const exchange = vi
      .spyOn(engine, 'oauthExchange')
      .mockResolvedValue({ access_token: 'tok-secret-123', expires_in: 600 })
    const { popup } = fakePopup()
    render(<SecretsBar services={['shop']} supplied={{}} />, host)
    await vi.waitFor(() => expect(button('Sign in')).toBeDefined())
    // the address to register is shown, and the paste fallback is still there
    expect(host.textContent).toContain(`${location.origin}${location.pathname}`)
    expect(host.querySelector('input[type="password"]')).not.toBeNull()

    const id = host.querySelector<HTMLInputElement>('input[aria-label^="Client id"]')
    expect(id).not.toBeNull()
    ;(id as HTMLInputElement).value = 'my-client'
    id?.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0)) // let the field's state settle before the click reads it
    button('Sign in')?.click()

    const back = await comeBack(popup, { code: 'c-1' })
    expect(back.sent.searchParams.get('client_id')).toBe('my-client')
    expect(back.sent.searchParams.get('scope')).toBe('read:orders')
    await vi.waitFor(() => expect(secretStore.get(API, 'SHOPAUTH')).toBe('tok-secret-123'))
    back.done()

    expect(exchange).toHaveBeenCalledWith(
      expect.objectContaining({ env: 'live', profile: 'shopAuth' }),
    )
    // folded to the chip; the token is not drawn, not in the address, not in persistent storage
    await vi.waitFor(() => expect(host.querySelector('.secrets-chip')).not.toBeNull())
    expect(host.innerHTML).not.toContain('tok-secret-123')
    expect(location.href).not.toContain('tok-secret-123')
    expect(JSON.stringify({ ...localStorage })).not.toContain('tok-secret-123')
    // the client id, which is public, is remembered for next time
    expect(JSON.stringify({ ...localStorage })).toContain('my-client')
  })

  it('reports a failed exchange and leaves the paste field usable', async () => {
    vi.spyOn(engine, 'oauthExchange').mockRejectedValue(
      new Error('The token endpoint answered 500'),
    )
    const { popup } = fakePopup()
    render(<SecretsBar services={['shop']} supplied={{}} />, host)
    await vi.waitFor(() => expect(button('Sign in')).toBeDefined())
    const id = host.querySelector<HTMLInputElement>(
      'input[aria-label^="Client id"]',
    ) as HTMLInputElement
    id.value = 'my-client'
    id.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    button('Sign in')?.click()

    const back = await comeBack(popup, { code: 'c-1' })
    await vi.waitFor(() => expect(host.textContent).toContain('The token endpoint answered 500'))
    back.done()
    expect(secretStore.get(API, 'SHOPAUTH')).toBeUndefined()
    expect(button('Sign in')).toBeDefined()
    expect(host.querySelector('input[type="password"]')).not.toBeNull()
  })

  it('offers no sign-in for a profile without one, and none in the mock environment', async () => {
    vi.spyOn(engine, 'config').mockResolvedValue({
      ...config,
      auth: {
        shopAuth: { ...config.auth?.shopAuth, oauth: undefined },
      },
    } as unknown as SpecbookConfig)
    render(<SecretsBar services={['shop']} supplied={{}} />, host)
    await vi.waitFor(() => expect(host.querySelector('input[type="password"]')).not.toBeNull())
    expect(button('Sign in')).toBeUndefined()

    vi.spyOn(engine, 'config').mockResolvedValue(config)
    env.value = 'mock'
    render(<SecretsBar services={['shop']} supplied={{}} />, host)
    await new Promise((r) => setTimeout(r, 100))
    expect(button('Sign in')).toBeUndefined()
  })
})
