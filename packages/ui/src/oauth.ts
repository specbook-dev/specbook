import {
  authorizeUrl,
  createPkce,
  newState,
  OAuthError,
  parseCallback,
  parseTokenResponse,
  tokenRequestFields,
} from '@specbook/core'
import { OAUTH_CHANNEL, type OAuthMessage } from './oauth-callback'

/**
 * Page side of "Sign in": opens the provider in a popup, waits for the return leg
 * (`oauth-callback.ts`), exchanges the code and hands back the access token. The verifier and the `state`
 * live in this closure only: not in the URL, not in storage, not in a log.
 */

/** The address a provider sends the person back to, and the one to register with it. */
export const redirectUri = (): string => `${location.origin}${location.pathname}`

export interface SignInInput {
  authorizationUrl: string
  clientId: string
  scopes: string[]
  /** posts the form to the token endpoint and returns the parsed response body */
  exchange(fields: Record<string, string>, signal?: AbortSignal): Promise<unknown>
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

  const channel = new BroadcastChannel(OAUTH_CHANNEL)
  try {
    const { verifier, challenge } = await createPkce()
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
      channel.onmessage = (e: MessageEvent<OAuthMessage>) => {
        const m = e.data
        if (m?.type !== 'callback' || m.state !== state) return
        stop()
        channel.postMessage({ type: 'ack', state } satisfies OAuthMessage)
        resolve(m)
      }
    })

    popup.location.href = authorizeUrl({
      authorizationUrl: i.authorizationUrl,
      clientId: i.clientId,
      redirectUri: redirect,
      scopes: i.scopes,
      state,
      challenge,
    })

    const back = await returned
    const { code } = parseCallback(
      {
        state: back.state,
        ...(back.code ? { code: back.code } : {}),
        ...(back.error ? { error: back.error } : {}),
        ...(back.description ? { error_description: back.description } : {}),
      },
      state,
    )
    const body = await i.exchange(
      tokenRequestFields({ code, verifier, clientId: i.clientId, redirectUri: redirect }),
      i.signal,
    )
    return parseTokenResponse(body)
  } finally {
    channel.close()
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

const readJson = (store: Storage, key: string): Record<string, any> => {
  try {
    return JSON.parse(store.getItem(key) ?? '{}')
  } catch {
    return {}
  }
}
const writeJson = (store: Storage, key: string, value: unknown) => {
  try {
    store.setItem(key, JSON.stringify(value))
  } catch {
    /* blocked or full: the page still works without it */
  }
}

export const recallClientId = (authorizationUrl: string): string | undefined => {
  try {
    return readJson(localStorage, CLIENTS)[authorizationUrl]
  } catch {
    return undefined
  }
}

export const rememberClientId = (authorizationUrl: string, clientId: string): void => {
  try {
    writeJson(localStorage, CLIENTS, {
      ...readJson(localStorage, CLIENTS),
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
    const t = readJson(sessionStorage, EXPIRY)
    if (expiresIn === undefined) delete t[expiryKey(origin, name)]
    else t[expiryKey(origin, name)] = Date.now() + expiresIn * 1000
    writeJson(sessionStorage, EXPIRY, t)
  } catch {
    /* no storage */
  }
}

export const expiryOf = (origin: string, name: string): number | undefined => {
  try {
    return readJson(sessionStorage, EXPIRY)[expiryKey(origin, name)]
  } catch {
    return undefined
  }
}
