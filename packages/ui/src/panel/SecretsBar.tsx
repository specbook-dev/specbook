import { type AuthProfile, absoluteBase } from '@specbook/core/internal'
import { useEffect, useState } from 'preact/hooks'
import { getChoice, setChoice } from '../auth-choice'
import { requiredScopes } from '../auth-describe'
import {
  type AuthOption,
  authOptions,
  availability,
  choosable,
  neededProfiles,
  type Security,
  STATUS,
  unservedSchemes,
} from '../auth-options'
import { expiryOf, noteExpiry } from '../oauth'
import { engine } from '../runtime'
import { originOf, secretStore } from '../secrets'
import { env, envSettingsOpen, envVarsVersion, version } from '../store'
import { OAuthSignIn } from './OAuthSignIn'

interface Need {
  service: string
  origin: string
  /** every profile the service lists, with sign-in addresses rendered for this environment */
  options: AuthOption[]
  auth: Record<string, AuthProfile | undefined>
  /** what the spec says each operation about to run needs; unknown when not given */
  securities: Security[]
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
 * Credentials, asked for where they are needed: the request or flow about to run. When a service offers more than one
 * way to authenticate and the operation accepts several, the person picks one here; an operation that accepts only one
 * says so. A value typed here goes into the request, bound to the API's origin, and stays in this tab. Where the dev
 * server already has one (an environment variable or a secrets file) it is listed as available and only needs a value
 * here to override it; a name nothing supplies is what the bar asks for. A profile whose secrets only a server may hold
 * (OAuth client credentials) is never asked of the page.
 */
export function SecretsBar({
  services,
  securities,
  enabled = true,
  supplied,
}: {
  services?: string[]
  /** per service, what the spec says about each operation the bar is for (a request: one; a flow: its steps) */
  securities?: Record<string, Security[]>
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
  const secured = JSON.stringify(securities ?? null)

  useEffect(() => {
    if (!live) {
      setNeeds([])
      return
    }
    let on = true
    if (!supplied) engine.managedSecrets(env.value).then((m) => on && setManaged(m))
    engine.config(version.value).then(async (cfg) => {
      const out: Need[] = []
      const where = await engine.addressesIn(cfg, env.value)
      for (const [service, s] of Object.entries(cfg.services ?? {})) {
        if (services && !services.includes(service)) continue
        // the address this environment's variables give; one that cannot be worked out has no origin
        const base = where.baseUrl(service)
        const origin = originOf(base ? absoluteBase(base, globalThis.location?.href) : undefined)
        const options = authOptions(cfg, service, (profile) => where.oauth(profile))
        if (!options.length || !origin || !s) continue
        out.push({
          service,
          origin,
          options,
          auth: (cfg.auth ?? {}) as Record<string, AuthProfile | undefined>,
          securities: securities?.[service] ?? [undefined],
        })
      }
      if (on) setNeeds(out)
    })
    return () => {
      on = false
    }
  }, [live, env.value, wanted, secured, version.value, envVarsVersion.value])

  if (!live || needs.length === 0) return null

  const hasServer = engine.hasServer()
  const stateOf = (n: Need, o: AuthOption) =>
    availability(
      o,
      (secret) => secretStore.get(n.origin, secret) !== undefined || managed[secret] !== undefined,
      (secret) => managed[secret] !== undefined,
      hasServer,
    )

  // what each service's operations will use, with the person's choice first
  const shown = needs
    .map((n) => {
      const listed = n.options.map((o) => o.name)
      const named = (names: string[]) =>
        names
          .map((name) => n.options.find((o) => o.name === name))
          .filter((o): o is AuthOption => !!o)
      return {
        n,
        needed: named(neededProfiles(listed, n.auth, n.securities, getChoice(n.service))),
        pick: named(choosable(listed, n.auth, n.securities)),
        unserved: unservedSchemes(listed, n.auth, n.securities),
      }
    })
    .filter((v) => v.needed.length > 0)
  if (shown.length === 0) return null

  const missing = shown.some((v) => v.needed.some((o) => stateOf(v.n, o) !== 'ready'))
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
          <span aria-hidden="true">🔑</span>{' '}
          {shown.map((v) => v.needed.map((o) => o.title).join(' + ') || v.n.service).join(' · ')} ✓
        </button>
      </div>
    )

  const fields = (n: Need, o: AuthOption, pick: AuthOption[]) => {
    if (o.kind === 'server') {
      const state = stateOf(n, o)
      const instead = pick.find((p) => p.kind !== 'server')
      return (
        <span class="needs-var auth-server">
          <code>{o.serverSecrets.join(', ')}</code>
          {state === 'ready' ? (
            <span class="muted">✓ held by the dev server, never sent to this page</span>
          ) : state === 'server-missing' ? (
            <>
              <span class="muted">held by the dev server; not set yet</span>
              <button type="button" class="link" onClick={() => (envSettingsOpen.value = true)}>
                Set them
              </button>
            </>
          ) : (
            <>
              <span class="muted">needs a server to keep it secret; this page has none</span>
              {instead && (
                <button
                  type="button"
                  class="link"
                  onClick={() => setChoice(n.service, instead.name)}
                >
                  Use {instead.title}
                </button>
              )}
            </>
          )}
        </span>
      )
    }
    return o.secrets.map((name) => {
      const has = secretStore.get(n.origin, name) !== undefined
      const from = managed[name]
      return (
        <span class="needs-var">
          <code>{name}</code>
          {has ? (
            <>
              <span class="muted">
                ✓ set
                {o.oauth && minutesLeft(expiryOf(n.origin, name)) !== undefined
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
              {o.oauth && (
                <OAuthSignIn
                  service={n.service}
                  profile={o.name}
                  origin={n.origin}
                  secret={name}
                  oauth={o.oauth}
                  requiredScopes={requiredScopes(n.securities, o.schemes)}
                  onSignedIn={() => bump((x) => x + 1)}
                />
              )}
              <input
                type="password"
                class={o.oauth ? 'token-input' : undefined}
                autocomplete="off"
                aria-label={`${name} for ${n.service}`}
                placeholder={
                  from ? 'use another value' : o.oauth ? 'or enter access token' : 'enter value'
                }
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
    })
  }

  return (
    <fieldset class={`needs-vars ${missing ? '' : 'ok'}`} aria-label="Credentials for this request">
      {shown.map(({ n, needed, pick, unserved }) => {
        // one way to choose among, when the operations accept more than one of the service's
        const choose = needed.length === 1 && pick.length > 1
        const active = needed[0]
        const single = n.options.length === 1
        return (
          <>
            <span class="muted" title={`Sent from this browser to ${n.origin}`}>
              {n.service}
              {single && active ? ` · ${active.title}` : ''}
            </span>
            {choose && (
              <fieldset class="auth-choice" aria-label={`Authorization for ${n.service}`}>
                {pick.map((o) => (
                  <label class={`auth-opt ${o.name === active?.name ? 'on' : ''}`}>
                    <input
                      type="radio"
                      name={`auth-${n.service}`}
                      checked={o.name === active?.name}
                      onChange={() => setChoice(n.service, o.name)}
                    />
                    <span class="auth-opt-title">{o.title}</span>{' '}
                    <span class="auth-opt-status muted">{STATUS[stateOf(n, o)]}</span>
                  </label>
                ))}
              </fieldset>
            )}
            {!choose && !single && needed.length === 1 && pick.length === 1 && active && (
              <span class="muted small auth-note">
                Accepts only {active.schemes.length ? active.schemes.join(', ') : active.title}.
              </span>
            )}
            {unserved.length > 0 && active && (
              <span class="muted small auth-note">
                The spec wants {unserved.join(', ')}; none of {n.service}’s profiles supplies it, so{' '}
                {active.title} is tried.
              </span>
            )}
            {needed.map((o) => (
              <>
                {needed.length > 1 && <span class="muted small auth-which">{o.title}</span>}
                {fields(n, o, pick)}
              </>
            ))}
          </>
        )
      })}
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
