import { useEffect, useMemo, useState } from 'preact/hooks'
import type { EnvironmentView, VariableRow } from '../engine'
import { refreshEnvironments } from '../environment-list'
import { engine, isStatic } from '../runtime'
import { env, envSettingsOpen, envVarsVersion, version } from '../store'

type Source = 'session' | 'process' | 'environment' | 'shared' | undefined
type Scope = 'environment' | 'session' | 'shared'

interface SecretRow {
  name: string
  key: string
  source: Source
}
interface EnvState {
  vars: Record<string, string>
  secrets: SecretRow[]
  warnings: string[]
}

const SOURCE_LABEL: Record<NonNullable<Source>, string> = {
  session: 'this session',
  process: 'environment variable',
  environment: 'environment file',
  shared: 'shared file',
}

const VARIABLE_LABEL: Record<VariableRow['source'], string> = {
  default: 'default',
  config: 'config',
  file: 'file',
  browser: 'this browser',
}

async function post(path: string, body: object) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'save failed')
}

/** What a variable is for in this environment: the calls and sign-ins that read it. */
function usesOf(row: VariableRow, view: EnvironmentView): string[] {
  const u = view.uses[row.name]
  if (!u) return []
  const out: string[] = []
  for (const service of u.services) {
    const a = view.addresses.find((x) => x.service === service)
    out.push(a?.url ? `${service} calls go to ${a.url}` : `${service} calls use this address`)
  }
  for (const p of u.profiles) out.push(`${p.profile} sign-in reads this (${p.field})`)
  return out
}

/**
 * Header control for what the selected environment needs: its variables (defaults from the config, and
 * the environment's own in `<env>.env`, committed, or in this browser) and secrets (`<env>.secrets.env`,
 * gitignored, or this session only). The badge counts secrets still missing.
 */
export function EnvironmentMenu() {
  const [state, setState] = useState<EnvState>()
  const [view, setView] = useState<EnvironmentView>()
  const [labels, setLabels] = useState<Record<string, string>>({})
  const open = envSettingsOpen.value
  const setOpen = (o: boolean) => (envSettingsOpen.value = o)
  const [scope, setScope] = useState<Scope>('environment')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [newVar, setNewVar] = useState({ name: '', value: '' })
  const [error, setError] = useState<string>()
  const name = env.value

  // the dev server's view of secrets (and committed-secret warnings); a static page has no files
  const refresh = () =>
    isStatic
      ? Promise.resolve()
      : fetch(`/__specbook/environment?env=${encodeURIComponent(name)}`)
          .then((r) => r.json() as Promise<EnvState>)
          .then(setState, () => setState(undefined))

  useEffect(() => {
    refresh()
    setScope(name === 'mock' ? 'session' : 'environment')
    setDraft({})
  }, [name])

  // the variables as the settings show them: defaults and overrides, and where each address goes
  useEffect(() => {
    let on = true
    engine.environmentView(name, version.value).then((v) => on && setView(v))
    return () => {
      on = false
    }
  }, [name, version.value, envVarsVersion.value])

  useEffect(() => {
    engine.config(version.value).then((cfg) => {
      const out: Record<string, string> = {}
      for (const [profile, p] of Object.entries(cfg.auth ?? {}))
        for (const m of JSON.stringify(p.apply).matchAll(/secrets\.([\w$-]+)/g))
          out[m[1] as string] = p.title ?? profile
      setLabels(out)
    })
  }, [])

  const missing = useMemo(
    () => (name === 'mock' ? 0 : (state?.secrets.filter((s) => !s.source).length ?? 0)),
    [state, name],
  )
  if (!view) return null
  if (!isStatic && !state) return null
  const secrets = state?.secrets ?? []
  const hasAnything = secrets.length > 0 || view.rows.length > 0 || name !== 'mock'
  if (!hasAnything) return null

  const run = async (fn: () => Promise<void>) => {
    setError(undefined)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const saveSecret = (secret: string, value: string) =>
    run(async () => {
      await post('/__specbook/secret', {
        name: secret,
        value,
        scope,
        env: scope === 'shared' ? undefined : name,
      })
      setDraft((d) => ({ ...d, [secret]: '' }))
    })
  // a variable change moves addresses and sign-in origins: what is derived from them is redone
  const saveVar = (varName: string, value: string | null) =>
    run(async () => {
      await engine.setVariable(name, varName, value === '' ? null : value)
      envVarsVersion.value += 1
    })
  const removeEnvironment = () =>
    run(async () => {
      engine.deleteEnvironment(name)
      env.value = 'mock'
      await refreshEnvironments()
    })

  const warnings = [
    ...(state?.warnings ?? []),
    ...(name === 'mock' ? [] : view.addresses.filter((a) => a.error).map((a) => a.error as string)),
  ]
  const ordered = [...view.rows].sort(
    (a, b) =>
      Number(!!view.uses[b.name]) - Number(!!view.uses[a.name]) || a.name.localeCompare(b.name),
  )

  return (
    <div class="envmenu">
      <button
        type="button"
        class="btn envmenu-btn"
        aria-expanded={open}
        title={`Variables and credentials for ${name}`}
        aria-label={
          missing > 0 ? `Environment settings, ${missing} missing` : 'Environment settings'
        }
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">⚙︎</span> <span class="envmenu-label">Environment settings</span>
        {missing > 0 && <span class="badge-missing">{missing}</span>}
      </button>

      {open && (
        <div class="envmenu-pop" role="dialog" aria-label={`Settings for ${name}`}>
          <header class="envmenu-head">
            <strong>{name}</strong>
            <span class="muted small">
              {name === 'mock' ? 'mocks need no credentials' : 'values apply to this environment'}
            </span>
            <span class="spacer" />
            <button type="button" class="icon" aria-label="Close" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>

          {warnings.map((w) => (
            <p class="envmenu-warn">{w}</p>
          ))}
          {error && <p class="envmenu-warn">{error}</p>}

          <section>
            <h3>Variables</h3>
            <p class="muted small">
              {isStatic ? (
                'Kept in this browser; the defaults come from the spec or site.'
              ) : (
                <>
                  Shared with the team in <code>.specbook/environments/{name}.env</code>. Defaults
                  come from specbook.config.ts.
                </>
              )}
            </p>
            {ordered.map((row) => {
              const own = row.source === 'file' || row.source === 'browser'
              const key = `var:${row.name}`
              return (
                <div key={row.name}>
                  <div class="envrow">
                    <code>{row.name}</code>
                    <input
                      aria-label={`Value of ${row.name}`}
                      value={draft[key] ?? row.value}
                      disabled={!row.editable}
                      onInput={(e) =>
                        setDraft({ ...draft, [key]: (e.target as HTMLInputElement).value })
                      }
                      onBlur={() => {
                        const next = draft[key]
                        if (next !== undefined && next !== row.value) saveVar(row.name, next)
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    />
                    <span class={`src ${own ? 'set' : 'inherited'}`}>
                      {VARIABLE_LABEL[row.source]}
                    </span>
                    {own && row.editable && (
                      <button
                        type="button"
                        class="icon"
                        aria-label={
                          row.fallback !== undefined ? `Reset ${row.name}` : `Remove ${row.name}`
                        }
                        title={
                          row.fallback !== undefined
                            ? `Back to ${row.fallback}`
                            : 'Remove this variable'
                        }
                        onClick={() => saveVar(row.name, null)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  {usesOf(row, view).map((line) => (
                    <p class="muted small envuse">{line}</p>
                  ))}
                </div>
              )
            })}
            {name !== 'mock' &&
              view.addresses
                .filter(
                  (a) =>
                    a.url && !Object.values(view.uses).some((u) => u.services.includes(a.service)),
                )
                .map((a) => (
                  <p class="muted small envuse">
                    {a.service} calls go to {a.url}
                  </p>
                ))}
            {name !== 'mock' && (
              <form
                class="envrow"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!newVar.name) return
                  saveVar(newVar.name, newVar.value).then(() => setNewVar({ name: '', value: '' }))
                }}
              >
                <input
                  placeholder="name"
                  aria-label="New variable name"
                  value={newVar.name}
                  onInput={(e) =>
                    setNewVar({ ...newVar, name: (e.target as HTMLInputElement).value })
                  }
                />
                <input
                  placeholder="value"
                  aria-label="New variable value"
                  value={newVar.value}
                  onInput={(e) =>
                    setNewVar({ ...newVar, value: (e.target as HTMLInputElement).value })
                  }
                />
                <button type="submit" class="btn" disabled={!newVar.name}>
                  Add
                </button>
              </form>
            )}
            {view.removable && (
              <p>
                <button type="button" class="link" onClick={removeEnvironment}>
                  Delete environment
                </button>
              </p>
            )}
          </section>

          {!isStatic && (
            <section>
              <h3>Secrets</h3>
              {secrets.length === 0 ? (
                <p class="muted small">
                  None declared. Add <code>secrets: {'{ NAME: {} }'}</code> to the config.
                </p>
              ) : (
                <>
                  <label class="envrow scope">
                    <span class="muted small">Save to</span>
                    <select
                      aria-label="Where to save secrets"
                      value={scope}
                      onChange={(e) => setScope((e.target as HTMLSelectElement).value as Scope)}
                    >
                      <option value="environment">{name}.secrets.env (remembered here)</option>
                      <option value="session">this session only</option>
                      <option value="shared">all environments (secrets.local.env)</option>
                    </select>
                  </label>
                  {secrets.map((s) => (
                    <form
                      class="secretrow"
                      onSubmit={(e) => {
                        e.preventDefault()
                        saveSecret(s.name, draft[s.name] ?? '')
                      }}
                    >
                      <div class="secretrow-head">
                        <span>{labels[s.name] ?? s.name}</span>
                        <code class="muted small">{s.key}</code>
                        <span class={`src ${s.source ? 'set' : 'missing'}`}>
                          {s.source ? SOURCE_LABEL[s.source] : 'missing'}
                        </span>
                      </div>
                      <div class="envrow">
                        <input
                          type="password"
                          autocomplete="off"
                          aria-label={`Value of ${s.name}`}
                          placeholder={s.source ? '•••••• (type to replace)' : 'paste a value'}
                          value={draft[s.name] ?? ''}
                          onInput={(e) =>
                            setDraft({ ...draft, [s.name]: (e.target as HTMLInputElement).value })
                          }
                        />
                        <button type="submit" class="btn" disabled={!draft[s.name]}>
                          Save
                        </button>
                        {s.source && s.source !== 'process' && (
                          <button
                            type="button"
                            class="link"
                            onClick={() => saveSecret(s.name, '')}
                            title="Remove the value from the selected place"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </form>
                  ))}
                </>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  )
}
