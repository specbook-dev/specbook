import { isDiscovery, type OAuthClientCredentials, type OAuthSettings } from '@specbook/core'
import { useEffect, useRef, useState } from 'preact/hooks'
import { noteExpiry, recallClientId, redirectUri, rememberClientId, signIn } from '../oauth'
import { engine } from '../runtime'
import { secretStore } from '../secrets'
import { env, envVarsVersion, version } from '../store'

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string }

interface Endpoints {
  authorizationUrl: string
  scopes: Record<string, string>
  flow?: 'authorizationCode' | 'implicit'
}

/**
 * "Sign in" for a scheme with an authorization code flow (or the legacy implicit one), or an OpenID Connect provider. The token lands
 * in the same tab-scoped store, bound to the API's origin, that a pasted value would, so everything
 * downstream is unchanged. A failure or a cancel only reports itself: the paste field next to this stays
 * usable.
 */
export function OAuthSignIn({
  service,
  profile,
  origin,
  secret,
  oauth,
  onSignedIn,
}: {
  service: string
  profile: string
  origin: string
  /** the secret the profile's `apply` reads; the token is stored under it */
  secret: string
  oauth: Exclude<OAuthSettings, OAuthClientCredentials>
  onSignedIn(): void
}) {
  // one provider, one remembered client id: keyed by the address that identifies the provider
  const providerKey = isDiscovery(oauth) ? oauth.openIdConnectUrl : oauth.authorizationUrl
  const [clientId, setClientId] = useState(
    () => oauth.clientId ?? recallClientId(providerKey) ?? '',
  )
  // another environment may sign in somewhere else, with its own client
  useEffect(() => {
    setClientId(oauth.clientId ?? recallClientId(providerKey) ?? '')
  }, [providerKey, oauth.clientId])
  const [endpoints, setEndpoints] = useState<Endpoints | undefined>(undefined)
  const [picked, setPicked] = useState<string[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const abort = useRef<AbortController | undefined>(undefined)
  const busy = status.kind === 'busy'
  const [attempt, setAttempt] = useState(0)

  // The provider's endpoints are settled before a click: the popup has to open from the click itself,
  // and an OpenID Connect provider has to be asked where it is first.
  useEffect(() => {
    let on = true
    setEndpoints(undefined)
    setStatus((s) => (s.kind === 'busy' ? s : { kind: 'idle' }))
    engine
      .oauthEndpoints({ env: env.value, version: version.value, profile })
      .then((found) => {
        if (!on) return
        setEndpoints(found)
        // OpenID Connect asks for `openid` alone until more is ticked; a plain OAuth scheme lists what
        // its operations need, so those are all ticked
        setPicked(isDiscovery(oauth) ? ['openid'] : Object.keys(found.scopes))
      })
      .catch((e: unknown) => {
        if (on) setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      on = false
    }
  }, [profile, env.value, version.value, attempt, envVarsVersion.value])

  const scopeNames = Object.keys(endpoints?.scopes ?? {})

  // called from the click itself: the popup must open before anything is awaited
  const start = () => {
    if (!endpoints) return setAttempt((n) => n + 1)
    const id = clientId.trim()
    if (!id)
      return setStatus({ kind: 'error', message: 'Enter the client id registered for this page.' })
    const ctl = new AbortController()
    abort.current = ctl
    setStatus({ kind: 'busy' })
    rememberClientId(providerKey, id)
    signIn({
      authorizationUrl: endpoints.authorizationUrl,
      clientId: id,
      scopes: picked,
      signal: ctl.signal,
      flow: endpoints.flow,
      // the implicit flow has no token endpoint: the token comes back in the address
      ...(endpoints.flow === 'implicit'
        ? {}
        : {
            exchange: (fields: Record<string, string>, signal?: AbortSignal) =>
              engine.oauthExchange({
                env: env.value,
                version: version.value,
                profile,
                fields,
                signal,
              }),
          }),
    })
      .then((token) => {
        secretStore.set(origin, secret, token.accessToken)
        noteExpiry(origin, secret, token.expiresIn)
        setStatus({ kind: 'idle' })
        onSignedIn()
      })
      .catch((e: unknown) =>
        setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) }),
      )
  }

  const failedLookup = !endpoints && status.kind === 'error'
  // the idle line (the address to register) is the only one a phone can do without
  const hint = !busy && status.kind !== 'error' && !!endpoints
  return (
    <span class="needs-var oauth-signin">
      <input
        type="text"
        autocomplete="off"
        aria-label={`Client id for ${service}`}
        placeholder="client id"
        value={clientId}
        disabled={busy}
        onInput={(e) => setClientId((e.target as HTMLInputElement).value)}
      />
      {busy ? (
        <button type="button" class="link" onClick={() => abort.current?.abort()}>
          Cancel
        </button>
      ) : (
        <button type="button" class="btn" disabled={!endpoints && !failedLookup} onClick={start}>
          {failedLookup ? 'Try again' : 'Sign in'}
        </button>
      )}
      {scopeNames.length > 0 && (
        <details>
          <summary class="muted small">
            Scopes ({picked.length} of {scopeNames.length})
          </summary>
          {scopeNames.map((s) => (
            <label class="small" title={endpoints?.scopes[s] || undefined}>
              <input
                type="checkbox"
                checked={picked.includes(s)}
                disabled={busy}
                onChange={(e) =>
                  setPicked((p) =>
                    (e.target as HTMLInputElement).checked ? [...p, s] : p.filter((x) => x !== s),
                  )
                }
              />{' '}
              <code>{s}</code>
            </label>
          ))}
        </details>
      )}
      <span
        class={`muted small oauth-status ${hint ? 'oauth-hint' : ''}`}
        role="status"
        aria-live="polite"
      >
        {busy
          ? 'Waiting for the sign-in window…'
          : status.kind === 'error'
            ? status.message
            : !endpoints
              ? 'Looking up the provider…'
              : `Register this redirect URI with the provider${endpoints.flow === 'implicit' ? ' (implicit flow: no client secret, the token is short-lived)' : ''}: ${redirectUri()}`}
      </span>
    </span>
  )
}
