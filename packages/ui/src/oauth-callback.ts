/**
 * The return leg of a sign-in. The identity provider redirects the popup to a page with `?code=&state=`
 * (or `?error=`); the implicit flow answers in the address fragment instead (`#access_token=&state=`, or
 * `#error=`), which never reaches a server. Run first on boot: when the tab that started the sign-in is waiting for this `state`
 * it takes the result and this popup closes without drawing the app.
 *
 * Two ways to reach the waiting tab, because each survives what the other does not:
 * - a same-origin `BroadcastChannel`: providers that send `Cross-Origin-Opener-Policy` sever
 *   `window.opener`, but a channel still connects the two pages;
 * - `window.opener.postMessage`: a viewer inside an iframe on another site has partitioned storage, so its
 *   channel never hears a top-level popup, but its window is still the popup's opener.
 *
 * A stray visit to a URL that merely looks like a callback is told nobody is waiting and carries on as a
 * normal page load. The hosted site's own callback page (`landing/oauth/callback/callback.js`) does the same
 * in plain JS; keep the two in step.
 */
export const OAUTH_CHANNEL = 'specbook-oauth'

export type OAuthMessage =
  | {
      type: 'callback'
      state: string
      code?: string
      error?: string
      description?: string
      /** the implicit flow's answer */
      token?: { accessToken: string; expiresIn?: number; scope?: string }
    }
  | { type: 'ack'; state: string }

/** How long a callback page waits to be told that someone is waiting for it. */
const ACK_WAIT_MS = 1500

export interface CallbackOptions {
  /**
   * Remove `?code=&state=` from the address even when no tab claims it (default). An embedded viewer sets
   * this to false: the page belongs to someone else, and its query may be their own application's sign-in.
   */
  stripWhenUnclaimed?: boolean
}

/** true when this page load was a sign-in's return and has been handed over: do not boot the app. */
export function handleOAuthCallback(options: CallbackOptions = {}): Promise<boolean> {
  const strip = options.stripWhenUnclaimed ?? true
  const here = globalThis.location
  if (!here || (typeof BroadcastChannel === 'undefined' && !globalThis.opener))
    return Promise.resolve(false)
  const q = new URLSearchParams(here.search)
  const h = new URLSearchParams(here.hash.replace(/^#/, ''))
  // the implicit flow answers in the fragment; the code flow in the query
  const inQuery = q.has('state') && (q.has('code') || q.has('error'))
  const inFragment = !inQuery && h.has('state') && (h.has('access_token') || h.has('error'))
  const source = inFragment ? h : q
  const state = source.get('state')
  if (!state || !(inQuery || inFragment)) return Promise.resolve(false)

  const expires = Number(source.get('expires_in'))
  const message: OAuthMessage = {
    type: 'callback',
    state,
    ...(source.get('code') ? { code: source.get('code') as string } : {}),
    ...(source.get('error') ? { error: source.get('error') as string } : {}),
    ...(source.get('error_description')
      ? { description: source.get('error_description') as string }
      : {}),
    ...(source.get('access_token')
      ? {
          token: {
            accessToken: source.get('access_token') as string,
            ...(source.get('expires_in') && Number.isFinite(expires) ? { expiresIn: expires } : {}),
            ...(source.get('scope') ? { scope: source.get('scope') as string } : {}),
          },
        }
      : {}),
  }
  // the code, the token and the state are single-use and do not belong in history or a copied address
  const clean = () =>
    history.replaceState(
      null,
      '',
      inFragment ? here.pathname + here.search : here.pathname + here.hash,
    )
  if (strip) clean()

  return new Promise((resolve) => {
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(OAUTH_CHANNEL)
    let finished = false
    const finish = (handled: boolean) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      channel?.close()
      removeEventListener('message', onMessage)
      resolve(handled)
    }
    const claimed = () => {
      if (finished) return
      clean()
      finish(true)
      document.body.textContent = 'Signed in. You can close this window.'
      window.close()
    }
    const isAck = (d: OAuthMessage | undefined) => d?.type === 'ack' && d.state === state
    const onMessage = (e: MessageEvent<OAuthMessage>) => {
      if (e.origin === here.origin && isAck(e.data)) claimed()
    }
    const timer = setTimeout(() => finish(false), ACK_WAIT_MS)
    if (channel) channel.onmessage = (e: MessageEvent<OAuthMessage>) => isAck(e.data) && claimed()
    addEventListener('message', onMessage)
    channel?.postMessage(message)
    try {
      window.opener?.postMessage(message, here.origin)
    } catch {
      /* the opener is cross-origin or gone: the channel is the only way */
    }
  })
}
