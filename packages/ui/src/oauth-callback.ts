/**
 * The return leg of a sign-in. The identity provider redirects the popup to this page with `?code=&state=`
 * (or `?error=`). Run first on boot: when the tab that started the sign-in is waiting for this `state`
 * it takes the result over a same-origin channel and this popup closes without drawing the app.
 *
 * A channel rather than `window.opener`: providers that send `Cross-Origin-Opener-Policy` sever the
 * opener, and a stray visit to a URL that merely looks like a callback is told nobody is waiting and
 * carries on as a normal page load (with the query removed from the address bar).
 */
export const OAUTH_CHANNEL = 'specbook-oauth'

export type OAuthMessage =
  | { type: 'callback'; state: string; code?: string; error?: string; description?: string }
  | { type: 'ack'; state: string }

/** How long a callback page waits to be told that someone is waiting for it. */
const ACK_WAIT_MS = 1500

/** true when this page load was a sign-in's return and has been handed over: do not boot the app. */
export function handleOAuthCallback(): Promise<boolean> {
  const here = globalThis.location
  if (!here || typeof BroadcastChannel === 'undefined') return Promise.resolve(false)
  const q = new URLSearchParams(here.search)
  const state = q.get('state')
  if (!state || !(q.has('code') || q.has('error'))) return Promise.resolve(false)

  const message: OAuthMessage = {
    type: 'callback',
    state,
    ...(q.get('code') ? { code: q.get('code') as string } : {}),
    ...(q.get('error') ? { error: q.get('error') as string } : {}),
    ...(q.get('error_description') ? { description: q.get('error_description') as string } : {}),
  }
  // the code and state are single-use and do not belong in history or a copied address
  history.replaceState(null, '', here.pathname + here.hash)

  return new Promise((resolve) => {
    const channel = new BroadcastChannel(OAUTH_CHANNEL)
    const done = (handled: boolean) => {
      clearTimeout(timer)
      channel.close()
      resolve(handled)
    }
    const timer = setTimeout(() => done(false), ACK_WAIT_MS)
    channel.onmessage = (e: MessageEvent<OAuthMessage>) => {
      if (e.data?.type !== 'ack' || e.data.state !== state) return
      done(true)
      document.body.textContent = 'Signed in. You can close this window.'
      window.close()
    }
    channel.postMessage(message)
  })
}
