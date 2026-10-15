import type { OAuthSettings } from '@specbook/core'
import { useRef, useState } from 'preact/hooks'
import { noteExpiry, recallClientId, redirectUri, rememberClientId, signIn } from '../oauth'
import { engine } from '../runtime'
import { secretStore } from '../secrets'
import { env, version } from '../store'

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string }

/**
 * "Sign in" for a scheme with an authorization code flow. The token lands in the same tab-scoped store,
 * bound to the API's origin, that a pasted value would, so everything downstream is unchanged. A failure
 * or a cancel only reports itself: the paste field next to this stays usable.
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
  oauth: OAuthSettings
  onSignedIn(): void
}) {
  const [clientId, setClientId] = useState(
    () => oauth.clientId ?? recallClientId(oauth.authorizationUrl) ?? '',
  )
  const scopeNames = Object.keys(oauth.scopes ?? {})
  const [picked, setPicked] = useState<string[]>(scopeNames)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const abort = useRef<AbortController | undefined>(undefined)
  const busy = status.kind === 'busy'

  // called from the click itself: the popup must open before anything is awaited
  const start = () => {
    const id = clientId.trim()
    if (!id)
      return setStatus({ kind: 'error', message: 'Enter the client id registered for this page.' })
    const ctl = new AbortController()
    abort.current = ctl
    setStatus({ kind: 'busy' })
    rememberClientId(oauth.authorizationUrl, id)
    signIn({
      authorizationUrl: oauth.authorizationUrl,
      clientId: id,
      scopes: picked,
      signal: ctl.signal,
      exchange: (fields, signal) =>
        engine.oauthExchange({ env: env.value, version: version.value, profile, fields, signal }),
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
        <button type="button" class="btn" onClick={start}>
          Sign in
        </button>
      )}
      {scopeNames.length > 0 && (
        <details>
          <summary class="muted small">
            Scopes ({picked.length} of {scopeNames.length})
          </summary>
          {scopeNames.map((s) => (
            <label class="small" title={oauth.scopes?.[s]}>
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
      <span class="muted small" role="status" aria-live="polite">
        {busy
          ? 'Waiting for the sign-in window…'
          : status.kind === 'error'
            ? status.message
            : `Register this redirect URI with the provider: ${redirectUri()}`}
      </span>
    </span>
  )
}
