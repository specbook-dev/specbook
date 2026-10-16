import { useState } from 'preact/hooks'
import { defaultFor, type FieldSpec, generateFor } from '../components/Fields'
import { Combo } from './Combo'

interface Props {
  title: string
  specs: Record<string, FieldSpec>
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

function hint(spec: FieldSpec): string {
  const bits: string[] = [spec.kind]
  if (spec.min !== undefined || spec.max !== undefined)
    bits.push(`${spec.min ?? ''}–${spec.max ?? ''}`)
  return bits.join(' · ')
}

/** One editable cell, by control kind. Nested objects and arrays are edited as JSON. */
function ValueCell({
  name,
  spec,
  value,
  onChange,
}: {
  name: string
  spec: FieldSpec
  value: unknown
  onChange: (v: unknown) => void
}) {
  const [raw, setRaw] = useState<string>()
  switch (spec.kind) {
    case 'number':
      return (
        <input
          class="cell"
          type="number"
          aria-label={name}
          value={String(value ?? '')}
          min={spec.min}
          max={spec.max}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value
            onChange(v === '' ? undefined : Number(v))
          }}
        />
      )
    case 'boolean':
      return (
        <Combo
          label={name}
          value={String(Boolean(value))}
          options={['true', 'false']}
          onChange={(v) => (v === 'true' || v === 'false' ? onChange(v === 'true') : undefined)}
        />
      )
    case 'date':
      return (
        <input
          class="cell"
          type="date"
          aria-label={name}
          value={String(value ?? '')}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        />
      )
    case 'select': {
      const options = spec.options ?? []
      const current = options.find((o) => same(o.value, value))
      return (
        <Combo
          label={name}
          value={current?.label ?? String(value ?? '')}
          options={options.map((o) => o.label)}
          onChange={(label) => {
            const hit = options.find((o) => o.label === label)
            if (hit) onChange(hit.value)
          }}
        />
      )
    }
    case 'multiselect': {
      const chosen = (value as unknown[]) ?? []
      return (
        <div class="multi-cell">
          {(spec.options ?? []).map((o) => (
            <label>
              <input
                type="checkbox"
                checked={chosen.some((c) => same(c, o.value))}
                onChange={(e) =>
                  onChange(
                    (e.target as HTMLInputElement).checked
                      ? [...chosen, o.value]
                      : chosen.filter((c) => !same(c, o.value)),
                  )
                }
              />
              {o.label}
            </label>
          ))}
        </div>
      )
    }
    case 'object':
    case 'array':
      return (
        <input
          class="cell mono"
          aria-label={name}
          value={raw ?? JSON.stringify(value ?? defaultFor(spec))}
          onInput={(e) => {
            const text = (e.target as HTMLInputElement).value
            setRaw(text)
            try {
              onChange(JSON.parse(text))
            } catch {
              /* keep typing; the last valid value stays */
            }
          }}
          onBlur={() => setRaw(undefined)}
        />
      )
    default:
      return (
        <input
          class="cell"
          aria-label={name}
          value={String(value ?? '')}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        />
      )
  }
}

/** A die: the control that makes another generated value. */
function Die() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" />
      <circle cx="5.2" cy="5.2" r="1.1" fill="currentColor" />
      <circle cx="10.8" cy="10.8" r="1.1" fill="currentColor" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
    </svg>
  )
}

/**
 * A flow's controls (inputs, or the choices of an input step) as the same spreadsheet the request
 * parameters use: name, value, description.
 */
export function ControlsGrid({ title, specs, values, onChange }: Props) {
  const names = Object.keys(specs)
  if (names.length === 0) return null
  const generated = names.filter((n) => specs[n]?.generate)
  return (
    <section class="grid controls-grid" aria-label={title}>
      <h3 class="controls-head">
        <span>{title}</span>
        {generated.length > 1 && (
          <button
            type="button"
            class="btn small gen-all"
            title="Make a new value for every generated input"
            onClick={() =>
              onChange({
                ...values,
                ...Object.fromEntries(
                  generated.map((n) => [n, generateFor(specs[n] as FieldSpec)]),
                ),
              })
            }
          >
            <Die /> Generate all
          </button>
        )}
      </h3>
      <table>
        <colgroup>
          <col class="c-key" />
          <col class="c-val" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th class="g-key">Name</th>
            <th class="g-val">Value</th>
            <th class="g-doc">Description</th>
          </tr>
        </thead>
        <tbody>
          {names.map((name) => {
            const spec = specs[name] as FieldSpec
            return (
              <tr key={name}>
                <td class="g-key">
                  <span class="key">
                    <code>{spec.label ?? name}</code>
                  </span>
                </td>
                <td class="g-val">
                  <div class={spec.generate ? 'cell-gen' : undefined}>
                    <ValueCell
                      name={name}
                      spec={spec}
                      value={values[name]}
                      onChange={(v) => onChange({ ...values, [name]: v })}
                    />
                    {spec.generate && (
                      <button
                        type="button"
                        class="gen"
                        aria-label={`Generate ${spec.label ?? name}`}
                        title="Make another value"
                        onClick={() => onChange({ ...values, [name]: generateFor(spec) })}
                      >
                        <Die />
                      </button>
                    )}
                  </div>
                </td>
                <td class="g-doc" title={spec.description}>
                  <span class="chip">{hint(spec)}</span> {spec.description}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
