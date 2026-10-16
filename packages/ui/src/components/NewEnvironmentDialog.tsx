import { useEffect, useRef, useState } from 'preact/hooks'
import { refreshEnvironments } from '../environment-list'
import { engine } from '../runtime'
import { env, environments, envSettingsOpen, newEnvironmentOpen, version } from '../store'

const NAME = /^[A-Za-z0-9_-]+$/

/**
 * Makes an environment as a copy of another one's variables: its own address, its own sign-in provider, the
 * same secrets as nothing (those are asked for again). In a project it becomes `.specbook/environments/<name>.env`;
 * on a page without files it is kept in this browser.
 */
export function NewEnvironmentDialog() {
  return newEnvironmentOpen.value ? <Dialog /> : null
}

// mounted only while open, so each opening starts fresh: empty name, a copy of what is being looked at
function Dialog() {
  const [name, setName] = useState('')
  const [from, setFrom] = useState(() =>
    // unless that is mock (nothing of its own to copy)
    env.value === 'mock' ? (environments.value.find((e) => e !== 'mock') ?? 'mock') : env.value,
  )
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') newEnvironmentOpen.value = false
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const close = () => (newEnvironmentOpen.value = false)
  const taken = environments.value.includes(name)
  const problem =
    name === ''
      ? undefined
      : !NAME.test(name)
        ? 'Use letters, digits, "-" and "_"'
        : name === 'mock' || taken
          ? `"${name}" already exists`
          : undefined

  const create = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await engine.createEnvironment(name, from, version.value)
      await refreshEnvironments()
      env.value = name
      newEnvironmentOpen.value = false
      envSettingsOpen.value = true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="palette-backdrop newenv-backdrop">
      <button type="button" class="palette-dismiss" aria-label="Close" onClick={close} />
      <div class="palette newenv" role="dialog" aria-label="New environment">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (name && !problem && !busy) create()
          }}
        >
          <h2>New environment</h2>
          <label>
            <span class="muted small">Name</span>
            <input
              ref={input}
              type="text"
              aria-label="Environment name"
              placeholder="staging"
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value.trim())}
            />
          </label>
          <label>
            <span class="muted small">Duplicate of</span>
            <select
              aria-label="Duplicate of"
              value={from}
              onChange={(e) => setFrom((e.target as HTMLSelectElement).value)}
            >
              {environments.value
                .filter((e) => e !== 'mock')
                .map((e) => (
                  <option value={e}>{e}</option>
                ))}
            </select>
          </label>
          <p class="muted small">
            It starts with {from}'s variables. Change its address in Variables; secrets are asked
            for again.
          </p>
          {(problem || error) && <p class="envmenu-warn">{problem ?? error}</p>}
          <div class="envrow">
            <span class="spacer" />
            <button type="button" class="btn" onClick={close}>
              Cancel
            </button>
            <button type="submit" class="btn primary" disabled={!name || !!problem || busy}>
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
