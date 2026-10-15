import type { AuthProfile, OAuthSettings } from '@specbook/core'
import { useEffect, useState } from 'preact/hooks'
import { expiryOf, noteExpiry } from '../oauth'
import { absoluteBase } from '../routing'
import { engine } from '../runtime'
import { originOf, SECRET_PLACEHOLDER, secretStore } from '../secrets'
import { env, version } from '../store'
import { OAuthSignIn } from './OAuthSignIn'

interface Need {
  service: string
  origin: string
  title: string
  names: string[]
  /** the config's name for the profile (the key a sign-in's token exchange is addressed by) */
  profile: string
  oauth?: OAuthSettings
}

const minutesLeft = (at: number | undefined) =>
  at === undefined ? undefined : Math.max(0, Math.round((at - Date.now()) / 60_000))

const SOURCE: Record<string, string> = {
  session: 'this session',
  process: 'environment variable',
  environment: 'environment file',
  shared: 'shared file',
}

/**
 * Credentials, asked for where they are needed: the request or flow about to run. A value typed here
 * goes into the request, bound to the API's own origin, and stays in this tab. Where the dev server
 * already has one (an environment variable or a secrets file) it is listed as available and only needs
 * a value here to override it; a name nothing supplies is what the bar asks for.
 */
export function SecretsBar({
  services,
  enabled = true,
  supplied,
}: {
  services?: string[]
  /** false hides the bar (the caller has its own way to ask) */
  enabled?: boolean
  /** names the executor already holds, by source; read from the engine unless given */
  supplied?: Record<string, string>
}) {
  const [needs, setNeeds] = useState<Need[]>([])
  const [asked, setManaged] = useState<Record<string, string>>({})
  const managed = supplied ?? asked
  const [, bump] = useState(0)
  // once nothing is missing the prompt folds to one small chip; a tap opens it again
  const [open, setOpen] = useState(false)
  const live = enabled && env.value !== 'mock'
  const wanted = services?.join('\n') ?? '*'

  useEffect(() => {
    if (!live) {
      setNeeds([])
      return
    }
    let on = true
    if (!supplied) engine.managedSecrets(env.value).then((m) => on && setManaged(m))
    engine.config(version.value).then((cfg) => {
      if (!on) return
      const out: Need[] = []
      for (const [service, s] of Object.entries(cfg.services ?? {})) {
        if (services && !services.includes(service)) continue
        const profile = s.auth ? cfg.auth?.[s.auth] : undefined
        const base = s.baseUrl?.[env.value]
        const origin = originOf(base ? absoluteBase(base, globalThis.location?.href) : undefined)
        if (!profile || !origin) continue
        const names = [
          ...new Set(
            [...JSON.stringify(profile.apply).matchAll(SECRET_PLACEHOLDER)].map(
              (m) => m[1] as string,
            ),
          ),
        ]
        if (names.length)
          out.push({
            service,
            origin,
            title: profile.title ?? s.auth ?? '',
            names,
            profile: s.auth as string,
            oauth: (profile as AuthProfile).oauth,
          })
      }
      setNeeds(out)
    })
    return () => {
      on = false
    }
  }, [live, env.value, wanted, version.value])

  if (!live || needs.length === 0) return null
  const have = (n: Need, name: string) =>
    secretStore.get(n.origin, name) !== undefined || managed[name] !== undefined
  const missing = needs.some((n) => n.names.some((x) => !have(n, x)))
  if (!missing && !open)
    return (
      <div class="secrets-folded">
        <button
          type="button"
          class="secrets-chip"
          aria-expanded="false"
          title="Credentials are available. Tap to change or clear the ones set in this tab."
          onClick={() => setOpen(true)}
        >
          <span aria-hidden="true">🔑</span> {needs.map((n) => n.title || n.service).join(' · ')} ✓
        </button>
      </div>
    )
  return (
    <fieldset class={`needs-vars ${missing ? '' : 'ok'}`} aria-label="Credentials for this request">
      {needs.map((n) => (
        <>
          <span class="muted" title={`Sent from this browser to ${n.origin}`}>
            {n.service} · {n.title}
          </span>
          {n.names.map((name) => {
            const has = secretStore.get(n.origin, name) !== undefined
            const from = managed[name]
            return (
              <span class="needs-var">
                <code>{name}</code>
                {has ? (
                  <>
                    <span class="muted">
                      ✓ set
                      {n.oauth && minutesLeft(expiryOf(n.origin, name)) !== undefined
                        ? ` · expires in ${minutesLeft(expiryOf(n.origin, name))} min`
                        : ''}
                    </span>
                    <button
                      type="button"
                      class="link"
                      onClick={() => {
                        secretStore.remove(n.origin, name)
                        noteExpiry(n.origin, name, undefined)
                        bump((x) => x + 1)
                      }}
                    >
                      Clear
                    </button>
                  </>
                ) : (
                  <>
                    {from && <span class="muted">from {SOURCE[from] ?? from}</span>}
                    {n.oauth && (
                      <OAuthSignIn
                        service={n.service}
                        profile={n.profile}
                        origin={n.origin}
                        secret={name}
                        oauth={n.oauth}
                        onSignedIn={() => bump((x) => x + 1)}
                      />
                    )}
                    <input
                      type="password"
                      autocomplete="off"
                      aria-label={`${name} for ${n.service}`}
                      placeholder={from ? 'use another value' : 'paste value'}
                      onChange={(e) => {
                        const v = (e.target as HTMLInputElement).value
                        if (v === '') return
                        secretStore.set(n.origin, name, v)
                        bump((x) => x + 1)
                      }}
                    />
                  </>
                )}
              </span>
            )
          })}
        </>
      ))}
      <span class="muted small secrets-note">
        Kept in this tab only; sent from your browser to the API.
      </span>
      {!missing && (
        <button type="button" class="link" onClick={() => setOpen(false)}>
          Hide
        </button>
      )}
    </fieldset>
  )
}
