import type { JSX } from 'preact'

/** Normalised field description, built from either a Control or a described input control. */
export interface FieldSpec {
  kind: string
  /** a friendlier name than the parameter key, and a sentence about it */
  label?: string
  description?: string
  default?: unknown
  /** makes a fresh starting value (a faker value): the control offers to generate another */
  generate?: () => unknown
  options?: { label: string; value: unknown }[]
  shape?: Record<string, FieldSpec>
  item?: FieldSpec
  min?: number
  max?: number
}

export function specFromControl(ctl: any): FieldSpec {
  const o = ctl.opts ?? {}
  const meta = {
    ...(typeof o.label === 'string' ? { label: o.label as string } : {}),
    ...(typeof o.description === 'string' ? { description: o.description as string } : {}),
  }
  return { ...baseSpec(ctl, o), ...meta }
}

function baseSpec(ctl: any, o: any): FieldSpec {
  switch (ctl.kind) {
    case 'select':
    case 'multiselect': {
      const value = (x: unknown) => (typeof o.value === 'function' ? o.value(x) : x)
      const label = (x: unknown) => (typeof o.label === 'function' ? o.label(x) : String(value(x)))
      return {
        kind: ctl.kind,
        options: (o.options as unknown[]).map((x) => ({ label: label(x), value: value(x) })),
      }
    }
    case 'object':
      return {
        kind: 'object',
        shape: Object.fromEntries(
          Object.entries(o.shape as Record<string, any>).map(([k, v]) => [k, specFromControl(v)]),
        ),
      }
    case 'array':
      return {
        kind: 'array',
        item: specFromControl(o.item),
        default: o.default,
        min: o.min,
        max: o.max,
      }
    default:
      return typeof o.default === 'function'
        ? { kind: ctl.kind, generate: o.default as () => unknown, min: o.min, max: o.max }
        : { kind: ctl.kind, default: o.default, min: o.min, max: o.max }
  }
}

/** A fresh generated value for a field, or its plain default when it has no generator or the generator cannot run. */
export function generateFor(spec: FieldSpec): unknown {
  if (spec.generate) {
    try {
      return spec.generate()
    } catch {
      /* faker is not ready: fall through to the plain default */
    }
  }
  return defaultFor({ ...spec, generate: undefined })
}

export function defaultFor(spec: FieldSpec): unknown {
  if (spec.generate) return generateFor(spec)
  switch (spec.kind) {
    case 'select':
      return spec.options?.[0]?.value
    case 'multiselect':
      return []
    case 'object':
      return Object.fromEntries(
        Object.entries(spec.shape ?? {}).map(([k, s]) => [k, defaultFor(s)]),
      )
    case 'array':
      return spec.default ?? []
    case 'boolean':
      return spec.default ?? false
    case 'number':
      return spec.default ?? 0
    default:
      return spec.default ?? ''
  }
}

interface FieldProps {
  name: string
  spec: FieldSpec
  value: unknown
  onChange: (v: unknown) => void
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

export function Field({ name, spec, value, onChange }: FieldProps): JSX.Element {
  const wrap = (body: JSX.Element) => (
    <div class="field">
      <span class="label">{name}</span>
      {body}
    </div>
  )
  switch (spec.kind) {
    case 'number':
      return wrap(
        <input
          type="number"
          value={Number(value ?? 0)}
          min={spec.min}
          max={spec.max}
          onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))}
        />,
      )
    case 'boolean':
      return wrap(
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
        />,
      )
    case 'date':
      return wrap(
        <input
          type="date"
          value={String(value ?? '')}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        />,
      )
    case 'select': {
      const idx = Math.max(
        0,
        (spec.options ?? []).findIndex((o) => same(o.value, value)),
      )
      return wrap(
        <select
          value={idx}
          onChange={(e) =>
            onChange(spec.options?.[Number((e.target as HTMLSelectElement).value)]?.value)
          }
        >
          {(spec.options ?? []).map((o, i) => (
            <option value={i}>{o.label}</option>
          ))}
        </select>,
      )
    }
    case 'multiselect': {
      const current = (value as unknown[]) ?? []
      return wrap(
        <div>
          {(spec.options ?? []).map((o) => (
            <label class="row">
              <input
                type="checkbox"
                checked={current.some((c) => same(c, o.value))}
                onChange={(e) =>
                  onChange(
                    (e.target as HTMLInputElement).checked
                      ? [...current, o.value]
                      : current.filter((c) => !same(c, o.value)),
                  )
                }
              />
              {o.label}
            </label>
          ))}
        </div>,
      )
    }
    case 'object': {
      const obj = (value ?? {}) as Record<string, unknown>
      return wrap(
        <div class="nested">
          {Object.entries(spec.shape ?? {}).map(([k, s]) => (
            <Field
              name={k}
              spec={s}
              value={obj[k]}
              onChange={(v) => onChange({ ...obj, [k]: v })}
            />
          ))}
        </div>,
      )
    }
    case 'array': {
      const list = (value as unknown[]) ?? []
      const item = spec.item as FieldSpec
      return wrap(
        <div class="nested">
          {list.map((v, i) => (
            <div class="row">
              <Field
                name={`#${i + 1}`}
                spec={item}
                value={v}
                onChange={(nv) => onChange(list.map((x, j) => (j === i ? nv : x)))}
              />
              <button
                type="button"
                class="btn"
                disabled={spec.min !== undefined && list.length <= spec.min}
                onClick={() => onChange(list.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            class="btn"
            disabled={spec.max !== undefined && list.length >= spec.max}
            onClick={() => onChange([...list, defaultFor(item)])}
          >
            Add
          </button>
        </div>,
      )
    }
    default:
      return wrap(
        <input
          type="text"
          value={String(value ?? '')}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        />,
      )
  }
}
