import { challengeFor, type SpecbookConfig } from '@specbook/core'
import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redirectUri, signIn } from '../../src/oauth'
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
async function comeBack(popup: FakePopup, extra: Record<string, unknown>, state?: string) {
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

describe('signIn with the implicit flow', () => {
  afterEach(() => vi.restoreAllMocks())

  it('asks for the token directly, with no challenge, and takes it from the return', async () => {
    const { popup } = fakePopup()
    const pending = signIn({
      authorizationUrl: AUTHORIZE,
      clientId: 'cid',
      scopes: ['read'],
      flow: 'implicit',
    })
    const back = await comeBack(popup, {
      token: { accessToken: 'tok-implicit', expiresIn: 600, scope: 'read' },
    })
    const q = back.sent.searchParams
    expect(q.get('response_type')).toBe('token')
    expect(q.get('client_id')).toBe('cid')
    expect(q.get('scope')).toBe('read')
    expect(q.get('code_challenge')).toBeNull()
    expect(q.get('code_challenge_method')).toBeNull()
    await expect(pending).resolves.toEqual({
      accessToken: 'tok-implicit',
      expiresIn: 600,
      scope: 'read',
    })
    await expect(back.acked).resolves.toBe(true)
    back.done()
    expect(popup.close).toHaveBeenCalled()
  })

  it('reports what the provider refused', async () => {
    const { popup } = fakePopup()
    const pending = signIn({
      authorizationUrl: AUTHORIZE,
      clientId: 'cid',
      scopes: [],
      flow: 'implicit',
    })
    const assertion = expect(pending).rejects.toThrow(/access_denied \(nope\)/)
    const back = await comeBack(popup, { error: 'access_denied', description: 'nope' })
    await assertion
    back.done()
  })

  it('does not take a return that carries no token', async () => {
    const { popup } = fakePopup()
    const pending = signIn({
      authorizationUrl: AUTHORIZE,
      clientId: 'cid',
      scopes: [],
      flow: 'implicit',
    })
    const assertion = expect(pending).rejects.toThrow(/no access token/)
    const back = await comeBack(popup, { code: 'a-code-is-not-a-token' })
    await assertion
    back.done()
  })

  it('ignores a return whose state is not its own', async () => {
    const { popup } = fakePopup()
    const ctl = new AbortController()
    const pending = signIn({
      authorizationUrl: AUTHORIZE,
      clientId: 'cid',
      scopes: [],
      flow: 'implicit',
      signal: ctl.signal,
    })
    const back = await comeBack(popup, { token: { accessToken: 'forged' } }, 'someone-elses-state')
    await new Promise((r) => setTimeout(r, 150))
    ctl.abort()
    await expect(pending).rejects.toThrow(/cancelled/)
    back.done()
  })

  it('needs an exchange for the code flow', async () => {
    fakePopup()
    await expect(
      signIn({ authorizationUrl: AUTHORIZE, clientId: 'cid', scopes: [] }),
    ).rejects.toThrow(/no token endpoint/)
  })
})

describe('the callback page, for the implicit flow', () => {
  const original = location.pathname + location.search + location.hash
  afterEach(() => {
    history.replaceState(null, '', original)
    vi.restoreAllMocks()
  })

  it('hands the token in the fragment to the waiting tab and removes it from the address', async () => {
    history.replaceState(
      null,
      '',
      `${location.pathname}#access_token=tok-frag&token_type=Bearer&expires_in=300&scope=read&state=s-frag`,
    )
    const seen: unknown[] = []
    const waiting = new BroadcastChannel('specbook-oauth')
    waiting.onmessage = (e) => {
      if (e.data?.type !== 'callback') return
      seen.push(e.data)
      waiting.postMessage({ type: 'ack', state: e.data.state })
    }
    const closed = vi.spyOn(window, 'close').mockImplementation(() => {})
    await expect(handleOAuthCallback()).resolves.toBe(true)
    expect(seen).toEqual([
      {
        type: 'callback',
        state: 's-frag',
        token: { accessToken: 'tok-frag', expiresIn: 300, scope: 'read' },
      },
    ])
    // the token is in neither the address nor its history entry
    expect(location.hash).toBe('')
    expect(location.href).not.toContain('tok-frag')
    expect(closed).toHaveBeenCalled()
    waiting.close()
  })

  it('removes an unclaimed fragment and carries on as a normal page load', async () => {
    history.replaceState(null, '', `${location.pathname}#access_token=stray&state=nobody`)
    await expect(handleOAuthCallback()).resolves.toBe(false)
    expect(location.hash).toBe('')
  })

  it('reports an error from the fragment', async () => {
    history.replaceState(
      null,
      '',
      `${location.pathname}#error=access_denied&error_description=nope&state=s-err`,
    )
    const seen: unknown[] = []
    const waiting = new BroadcastChannel('specbook-oauth')
    waiting.onmessage = (e) => {
      if (e.data?.type !== 'callback') return
      seen.push(e.data)
      waiting.postMessage({ type: 'ack', state: e.data.state })
    }
    vi.spyOn(window, 'close').mockImplementation(() => {})
    await expect(handleOAuthCallback()).resolves.toBe(true)
    expect(seen).toEqual([
      { type: 'callback', state: 's-err', error: 'access_denied', description: 'nope' },
    ])
    waiting.close()
  })

  it('leaves an ordinary hash alone', async () => {
    history.replaceState(null, '', `${location.pathname}#/operations/GetPet`)
    await expect(handleOAuthCallback()).resolves.toBe(false)
    expect(location.hash).toBe('#/operations/GetPet')
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
    // the endpoints the page would resolve from the config above
    vi.spyOn(engine, 'oauthEndpoints').mockResolvedValue({
      authorizationUrl: AUTHORIZE,
      tokenUrl: TOKEN,
      scopes: { 'read:orders': 'read orders' },
    })
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

  it('asks for the scopes the operation needs, not every scope the scheme lists', async () => {
    const scoped = {
      ...config,
      auth: {
        shopAuth: { ...(config.auth as Record<string, object>).shopAuth, scheme: 'orders_auth' },
      },
    } as unknown as SpecbookConfig
    vi.spyOn(engine, 'config').mockResolvedValue(scoped)
    vi.spyOn(engine, 'oauthEndpoints').mockResolvedValue({
      authorizationUrl: AUTHORIZE,
      tokenUrl: TOKEN,
      scopes: { 'read:orders': '', 'write:orders': '', 'delete:orders': '' },
    })
    vi.spyOn(engine, 'oauthExchange').mockResolvedValue({ access_token: 'tok-scoped' })
    const { popup } = fakePopup()
    render(
      <SecretsBar
        services={['shop']}
        securities={{ shop: [[{ orders_auth: ['write:orders'] }]] }}
        supplied={{}}
      />,
      host,
    )
    await vi.waitFor(() => expect(host.textContent).toContain('Scopes (1 of 3)'))
    const id = host.querySelector<HTMLInputElement>(
      'input[aria-label^="Client id"]',
    ) as HTMLInputElement
    id.value = 'my-client'
    id.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    button('Sign in')?.click()
    const back = await comeBack(popup, { code: 'c-2' })
    expect(back.sent.searchParams.get('scope')).toBe('write:orders')
    await vi.waitFor(() => expect(secretStore.get(API, 'SHOPAUTH')).toBe('tok-scoped'))
    back.done()
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

  describe('with an OpenID Connect provider', () => {
    const oidcConfig = {
      ...config,
      auth: {
        shopAuth: {
          ...config.auth?.shopAuth,
          oauth: { openIdConnectUrl: 'https://sso.example.com/.well-known/openid-configuration' },
        },
      },
    } as unknown as SpecbookConfig

    it('waits for the provider’s endpoints, asks for openid alone, and signs in at the discovered address', async () => {
      vi.spyOn(engine, 'config').mockResolvedValue(oidcConfig)
      let found!: (v: unknown) => void
      vi.spyOn(engine, 'oauthEndpoints').mockReturnValue(
        new Promise((r) => {
          found = r
        }) as never,
      )
      vi.spyOn(engine, 'oauthExchange').mockResolvedValue({ access_token: 'oidc-tok' })
      const { popup } = fakePopup()
      render(<SecretsBar services={['shop']} supplied={{}} />, host)
      await vi.waitFor(() => expect(button('Sign in')).toBeDefined())
      // not clickable until the provider has said where it is
      expect(button('Sign in')?.disabled).toBe(true)
      expect(host.textContent).toContain('Looking up the provider')

      found({
        authorizationUrl: 'https://sso.example.com/o/authorize',
        tokenUrl: 'https://tokens.example.com/token',
        scopes: { openid: '', email: '', profile: '' },
      })
      await vi.waitFor(() => expect(button('Sign in')?.disabled).toBe(false))
      expect(host.textContent).toContain('Scopes (1 of 3)')

      const id = host.querySelector<HTMLInputElement>(
        'input[aria-label^="Client id"]',
      ) as HTMLInputElement
      id.value = 'oidc-client'
      id.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
      button('Sign in')?.click()

      const back = await comeBack(popup, { code: 'c-9' })
      expect(back.sent.origin + back.sent.pathname).toBe('https://sso.example.com/o/authorize')
      expect(back.sent.searchParams.get('scope')).toBe('openid')
      await vi.waitFor(() => expect(secretStore.get(API, 'SHOPAUTH')).toBe('oidc-tok'))
      back.done()
    })

    it('says what went wrong when the provider cannot be found, and lets you try again', async () => {
      vi.spyOn(engine, 'config').mockResolvedValue(oidcConfig)
      const lookup = vi
        .spyOn(engine, 'oauthEndpoints')
        .mockRejectedValueOnce(new Error("The provider's discovery document answered 503"))
        .mockResolvedValue({
          authorizationUrl: 'https://sso.example.com/o/authorize',
          tokenUrl: 'https://tokens.example.com/token',
          scopes: { openid: '' },
        })
      render(<SecretsBar services={['shop']} supplied={{}} />, host)
      await vi.waitFor(() => expect(host.textContent).toContain('answered 503'))
      // the paste field is still there
      expect(host.querySelector('input[type="password"]')).not.toBeNull()
      button('Try again')?.click()
      await vi.waitFor(() => expect(button('Sign in')?.disabled).toBe(false))
      expect(lookup).toHaveBeenCalledTimes(2)
      expect(host.textContent).not.toContain('answered 503')
    })
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

describe('the address a provider sends the person back to', () => {
  const tag = () => document.head.querySelector('meta[name="specbook-oauth-callback"]')
  const declare = (content: string) => {
    const m = document.createElement('meta')
    m.name = 'specbook-oauth-callback'
    m.content = content
    document.head.append(m)
  }
  afterEach(() => {
    tag()?.remove()
    vi.restoreAllMocks()
  })

  it('is the page’s own address unless the page declares a callback page', () => {
    expect(redirectUri()).toBe(`${location.origin}${location.pathname}`)
    declare('/oauth/callback/')
    expect(redirectUri()).toBe(`${location.origin}/oauth/callback/`)
  })

  it('falls back to the page’s own address when the declaration is not an address', () => {
    declare('http://[not an address')
    expect(redirectUri()).toBe(`${location.origin}${location.pathname}`)
  })

  it('is what both the authorization request and the token exchange send', async () => {
    declare('/oauth/callback/')
    const { popup } = fakePopup()
    const exchange = vi.fn().mockResolvedValue({ access_token: 'tok' })
    const pending = signIn({ authorizationUrl: AUTHORIZE, clientId: 'cid', scopes: [], exchange })
    const back = await comeBack(popup, { code: 'c' })
    await pending
    back.done()
    expect(back.sent.searchParams.get('redirect_uri')).toBe(`${location.origin}/oauth/callback/`)
    expect(exchange.mock.calls[0]?.[0]).toMatchObject({
      redirect_uri: `${location.origin}/oauth/callback/`,
    })
  })
})

describe('signIn, when the return comes from the popup as its opener', () => {
  afterEach(() => vi.restoreAllMocks())

  /** What a callback page posts to `window.opener`, as the opening window sees it. */
  const fromOpener = (data: unknown, origin = location.origin) =>
    dispatchEvent(new MessageEvent('message', { data, origin, source: window }))

  const start = async (exchange = vi.fn().mockResolvedValue({ access_token: 'tok-pm' })) => {
    const { popup } = fakePopup()
    const ctl = new AbortController()
    const pending = signIn({
      authorizationUrl: AUTHORIZE,
      clientId: 'cid',
      scopes: [],
      exchange,
      signal: ctl.signal,
    })
    const sent = await vi.waitFor(() => {
      expect(popup.location.href).not.toBe('')
      return new URL(popup.location.href)
    })
    return { pending, ctl, exchange, state: sent.searchParams.get('state') as string }
  }

  it('accepts a message from its own origin with its own state, and acknowledges it to the sender', async () => {
    const acks: unknown[] = []
    const spy = (e: MessageEvent) => e.data?.type === 'ack' && acks.push(e.data)
    addEventListener('message', spy)
    try {
      const { pending, exchange, state } = await start()
      fromOpener({ type: 'callback', state, code: 'the-code' })
      await expect(pending).resolves.toMatchObject({ accessToken: 'tok-pm' })
      expect(exchange.mock.calls[0]?.[0]).toMatchObject({ code: 'the-code' })
      await vi.waitFor(() => expect(acks).toEqual([{ type: 'ack', state }]))
    } finally {
      removeEventListener('message', spy)
    }
  })

  it('ignores a message from another origin, and one with another state', async () => {
    const { pending, ctl, exchange, state } = await start()
    fromOpener({ type: 'callback', state, code: 'forged' }, 'https://evil.example')
    fromOpener({ type: 'callback', state: 'not-ours', code: 'forged' })
    await new Promise((r) => setTimeout(r, 150))
    expect(exchange).not.toHaveBeenCalled()
    ctl.abort()
    await expect(pending).rejects.toThrow(/cancelled/)
  })
})

describe('an embedded viewer on someone else’s page', () => {
  const original = location.pathname + location.search + location.hash
  afterEach(() => {
    history.replaceState(null, '', original)
    vi.restoreAllMocks()
  })

  it('leaves the address alone when no sign-in claims it: it may be the host application’s own', async () => {
    history.replaceState(null, '', `${location.pathname}?code=hostapp&state=theirs`)
    await expect(handleOAuthCallback({ stripWhenUnclaimed: false })).resolves.toBe(false)
    expect(location.search).toBe('?code=hostapp&state=theirs')
  })

  it('removes it once a waiting tab takes the result', async () => {
    history.replaceState(null, '', `${location.pathname}?code=abc&state=s-embed`)
    const waiting = new BroadcastChannel('specbook-oauth')
    waiting.onmessage = (e) => {
      if (e.data?.type === 'callback') waiting.postMessage({ type: 'ack', state: e.data.state })
    }
    const closed = vi.spyOn(window, 'close').mockImplementation(() => {})
    await expect(handleOAuthCallback({ stripWhenUnclaimed: false })).resolves.toBe(true)
    expect(location.search).toBe('')
    expect(closed).toHaveBeenCalled()
    waiting.close()
  })
})
