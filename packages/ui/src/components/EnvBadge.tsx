import { env, environmentNote, environmentRisk, environments } from '../store'

/**
 * The environment a request will run in, and a way to change it. On a phone the header with the
 * selector is behind a menu or under a panel, so the chip appears in the header and in each panel: it
 * is a real control (a transparent native select over the label), so a tap opens the platform picker.
 * Anything but `mock` is flagged, and production more strongly: an environment the config marks
 * `risk: 'production'`, or by default one whose name contains "prod".
 */
export function EnvBadge() {
  const name = env.value
  const names = environments.value.includes(name)
    ? environments.value
    : [name, ...environments.value]
  const risk = environmentRisk.value[name]
  const kind =
    name === 'mock'
      ? 'mock'
      : risk === 'production' || (risk !== 'sandbox' && /prod/i.test(name))
        ? 'prod'
        : 'live'
  const switchable = names.length > 1
  return (
    <span
      class={`env-badge ${kind} ${switchable ? 'switch' : ''}`}
      title={
        name === 'mock'
          ? 'Environment: mock (no network)'
          : `Environment: ${name}. Requests go to the real API.`
      }
    >
      <span class="env-name">{name}</span>
      {switchable && (
        <select
          aria-label="Environment"
          value={name}
          onChange={(e) => (env.value = (e.target as HTMLSelectElement).value)}
        >
          {names.map((n) => (
            <option value={n} title={environmentNote.value[n]}>
              {n}
            </option>
          ))}
        </select>
      )}
    </span>
  )
}
