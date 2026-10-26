import {
  authorizeUrl,
  createPkce,
  newState,
  OAuthError,
  parseCallback,
  parseImplicitCallback,
  parseTokenResponse,
  tokenRequestFields,
} from '@specbook/core/internal'
import { OAUTH_CHANNEL, type OAuthMessage } from './oauth-callback'
import { kv, type Store } from './storage'

/**
 * Page side of "Sign in": opens the provider in a popup, waits for the return leg
 * (`oauth-callback.ts`), exchanges the code and hands back the access token. The verifier and the `state`
 * live in this closure only: not in the URL, not in storage, not in a log.
 */

/**
 * The address a provider sends the person back to, and the one to register with it.
 *
 * The hosted site declares a stable, unversioned callback page (a `<meta>` its assembly adds to the viewer's
 * `index.html`), so what people register does not change with the viewer's channel (`/v1/`, `/v2/`).
 * Anywhere else (a self-hosted copy, an embed on a host page, the dev server) it is the page's own address.
 */
export const redirectUri = (): string => {
  const declared = document
    .querySelector<HTMLMetaElement>('meta[name="specbook-oauth-callback"]')
    ?.content.trim()
  if (declared) {
    try {
      return new URL(declared, location.origin).href
    } catch {
      /* not an address: fall back to the page's own */
    }
  }
  return `${location.origin}${location.pathname}`
}

export interface SignInInput {
  authorizationUrl: string
  clientId: string
  scopes: string[]
  /** `implicit` gets the token in the address and has no exchange; the default is the code with PKCE */
  flow?: 'authorizationCode' | 'implicit'
  /** posts the form to the token endpoint and returns the parsed response body (not used by the implicit flow) */
  exchange?(fields: Record<string, string>, signal?: AbortSignal): Promise<unknown>
  signal?: AbortSignal
  /** how long to wait for the person to finish (default five minutes) */
  timeoutMs?: number
}

/**
 * Call this straight from a click: the popup has to open before anything is awaited or the browser
 * blocks it.
 */
export async function signIn(
  i: SignInInput,
): Promise<{ accessToken: string; expiresIn?: number; scope?: string }> {
  // opened blank and pointed at the provider once the challenge exists, which keeps Safari's
  // user-activation rule happy
  const popup = window.open('', OAUTH_CHANNEL, 'popup,width=520,height=720')
  if (!popup)
    throw new OAuthError(
      'The browser blocked the sign-in window. Allow pop-ups for this page and try again.',
    )

  const implicit = i.flow === 'implicit'
  if (!implicit && !i.exchange) {
    popup.close()
    throw new OAuthError('Sign-in has no token endpoint to exchange the code at.')
  }
  const channel = new BroadcastChannel(OAUTH_CHANNEL)
  let onWindowMessage: ((e: MessageEvent<OAuthMessage>) => void) | undefined
  try {
    // the implicit flow has no code to protect, so no verifier
    const pkce = implicit ? undefined : await createPkce()
    const state = newState()
    const redirect = redirectUri()

    const returned = new Promise<OAuthMessage & { type: 'callback' }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new OAuthError('Sign-in timed out. Try again.')),
        i.timeoutMs ?? 5 * 60_000,
      )
      const stop = () => clearTimeout(timer)
      i.signal?.addEventListener('abort', () => {
        stop()
        reject(new OAuthError('Sign-in was cancelled.'))
      })
      // the return arrives over the channel or from the popup as its opener; both carry the same message,
      // and the one that arrives second is a repeat of the first
      const take = (m: OAuthMessage | undefined, ack: (a: OAuthMessage) => void) => {
        if (m?.type !== 'callback' || m.state !== state) return
        stop()
        ack({ type: 'ack', state })
        resolve(m)
      }
      channel.onmessage = (e: MessageEvent<OAuthMessage>) =>
        take(e.data, (a) => channel.postMessage(a))
      onWindowMessage = (e: MessageEvent<OAuthMessage>) => {
        // only this origin's own callback page: another site cannot hand us a code
        if (e.origin !== location.origin) return
        take(e.data, (a) => (e.source as Window | null)?.postMessage(a, location.origin))
      }
      addEventListener('message', onWindowMessage)
    })

    popup.location.href = authorizeUrl({
      authorizationUrl: i.authorizationUrl,
      clientId: i.clientId,
      redirectUri: redirect,
      scopes: i.scopes,
      state,
      ...(pkce ? { challenge: pkce.challenge } : { responseType: 'token' as const }),
    })

    const back = await returned
    if (implicit)
      return parseImplicitCallback(
        {
          state: back.state,
          ...(back.token ? { access_token: back.token.accessToken } : {}),
          ...(back.token?.expiresIn !== undefined
            ? { expires_in: String(back.token.expiresIn) }
            : {}),
          ...(back.token?.scope ? { scope: back.token.scope } : {}),
          ...(back.error ? { error: back.error } : {}),
          ...(back.description ? { error_description: back.description } : {}),
        },
        state,
      )
    const { code } = parseCallback(
      {
        state: back.state,
        ...(back.code ? { code: back.code } : {}),
        ...(back.error ? { error: back.error } : {}),
        ...(back.description ? { error_description: back.description } : {}),
      },
      state,
    )
    const body = await (i.exchange as NonNullable<SignInInput['exchange']>)(
      tokenRequestFields({
        code,
        verifier: (pkce as NonNullable<typeof pkce>).verifier,
        clientId: i.clientId,
        redirectUri: redirect,
      }),
      i.signal,
    )
    return parseTokenResponse(body)
  } finally {
    channel.close()
    if (onWindowMessage) removeEventListener('message', onWindowMessage)
    try {
      popup.close()
    } catch {
      /* a severed popup cannot be closed from here; the callback page closes itself */
    }
  }
}

// ---- small per-browser conveniences: a client id is public, and an expiry note is not a secret ----

const CLIENTS = 'specbook.oauth.clients.v1'
const EXPIRY = 'specbook.oauth.expiry.v1'

const readJson = (store: Store, key: string): Record<string, any> => {
  try {
    return JSON.parse(store.getItem(key) ?? '{}')
  } catch {
    return {}
  }
}
const writeJson = (store: Store, key: string, value: unknown) => {
  try {
    store.setItem(key, JSON.stringify(value))
  } catch {
    /* blocked or full: the page still works without it */
  }
}

export const recallClientId = (authorizationUrl: string): string | undefined => {
  try {
    return readJson(kv.local, CLIENTS)[authorizationUrl]
  } catch {
    return undefined
  }
}

export const rememberClientId = (authorizationUrl: string, clientId: string): void => {
  try {
    writeJson(kv.local, CLIENTS, {
      ...readJson(kv.local, CLIENTS),
      [authorizationUrl]: clientId,
    })
  } catch {
    /* no storage */
  }
}

const expiryKey = (origin: string, name: string) => `${origin}\n${name}`

/** Remembered for this tab only, to say "expires in 59 min"; the token itself stays in the secret store. */
export const noteExpiry = (origin: string, name: string, expiresIn: number | undefined): void => {
  try {
    const t = readJson(kv.session, EXPIRY)
    if (expiresIn === undefined) delete t[expiryKey(origin, name)]
    else t[expiryKey(origin, name)] = Date.now() + expiresIn * 1000
    writeJson(kv.session, EXPIRY, t)
  } catch {
    /* no storage */
  }
}

export const expiryOf = (origin: string, name: string): number | undefined => {
  try {
    return readJson(kv.session, EXPIRY)[expiryKey(origin, name)]
  } catch {
    return undefined
  }
}
