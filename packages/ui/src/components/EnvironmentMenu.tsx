import { useEffect, useMemo, useState } from 'preact/hooks'
import { engine, isStatic } from '../runtime'
import { env, version } from '../store'

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

async function post(path: string, body: object) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'save failed')
}

/**
 * Header control for what the selected environment needs: its variables (`<env>.env`, committed) and
 * secrets (`<env>.secrets.env`, gitignored, or this session only). The badge counts secrets still missing.
 */
export function EnvironmentMenu() {
  const [state, setState] = useState<EnvState>()
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<Scope>('environment')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [newVar, setNewVar] = useState({ name: '', value: '' })
  const [error, setError] = useState<string>()
  const name = env.value

  const refresh = () =>
    fetch(`/__specbook/environment?env=${encodeURIComponent(name)}`)
      .then((r) => r.json() as Promise<EnvState>)
      .then(setState, () => setState(undefined))

  useEffect(() => {
    if (isStatic) return
    refresh()
    setScope(name === 'mock' ? 'session' : 'environment')
    setDraft({})
  }, [name])

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
  if (isStatic || !state) return null
  const hasAnything =
    state.secrets.length > 0 || Object.keys(state.vars).length > 0 || name !== 'mock'
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
  const saveVar = (varName: string, value: string | null) =>
    run(() => post('/__specbook/var', { env: name, name: varName, value }))

  return (
    <div class="envmenu">
      <button
        type="button"
        class="btn envmenu-btn"
        aria-expanded={open}
        title={`Variables and credentials for ${name}`}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">⚙︎</span> Environment settings
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

          {state.warnings.map((w) => (
            <p class="envmenu-warn">{w}</p>
          ))}
          {error && <p class="envmenu-warn">{error}</p>}

          <section>
            <h3>Variables</h3>
            <p class="muted small">
              Shared with the team in <code>.specbook/environments/{name}.env</code>.
            </p>
            {Object.entries(state.vars).map(([k, v]) => (
              <div class="envrow">
                <code>{k}</code>
                <input
                  aria-label={`Value of ${k}`}
                  value={draft[`var:${k}`] ?? v}
                  onInput={(e) =>
                    setDraft({ ...draft, [`var:${k}`]: (e.target as HTMLInputElement).value })
                  }
                  onBlur={() => {
                    const next = draft[`var:${k}`]
                    if (next !== undefined && next !== v) saveVar(k, next)
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
                <button
                  type="button"
                  class="icon"
                  aria-label={`Remove ${k}`}
                  onClick={() => saveVar(k, null)}
                >
                  ×
                </button>
              </div>
            ))}
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
          </section>

          <section>
            <h3>Secrets</h3>
            {state.secrets.length === 0 ? (
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
                {state.secrets.map((s) => (
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
        </div>
      )}
    </div>
  )
}
