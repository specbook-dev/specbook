import { resolveControl } from '@specbook/core'
import { short } from '../panel/short'

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
      let initial: unknown
      try {
        // what the CLI starts from, so the form and `specbook test` agree on a default that is not the first option
        initial = resolveControl('', ctl, undefined)
      } catch {
        /* no options */
      }
      return {
        kind: ctl.kind,
        options: (o.options as unknown[]).map((x) => ({ label: label(x), value: value(x) })),
        ...(initial !== undefined ? { default: initial } : {}),
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
      return spec.default ?? spec.options?.[0]?.value
    case 'multiselect':
      return spec.default ?? []
    case 'object':
      return Object.fromEntries(
        Object.entries(spec.shape ?? {}).map(([k, s]) => [k, defaultFor(s)]),
      )
    case 'array': {
      const item = spec.item as FieldSpec
      // a given list is filled item by item; none starts at its minimum, each item from its own defaults
      const list = typeof spec.default === 'function' ? spec.default() : spec.default
      if (Array.isArray(list)) return list.map((x) => withDefaults(item, x))
      return Array.from({ length: spec.min ?? 0 }, () => defaultFor(item))
    }
    case 'boolean':
      return spec.default ?? false
    case 'number':
      return spec.default ?? 0
    default:
      return spec.default ?? ''
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A value made whole: what is missing comes from the defaults (a preset of one field of a group leaves the others). */
export function withDefaults(spec: FieldSpec, given: unknown): unknown {
  if (given === undefined) return defaultFor(spec)
  if (spec.kind === 'object') {
    if (!isObject(given)) return defaultFor(spec)
    return {
      ...given,
      ...Object.fromEntries(
        Object.entries(spec.shape ?? {}).map(([k, s]) => [k, withDefaults(s, given[k])]),
      ),
    }
  }
  if (spec.kind === 'array') {
    if (!Array.isArray(given)) return defaultFor(spec)
    const item = spec.item as FieldSpec
    const list = given.map((x) => withDefaults(item, x))
    while (spec.min !== undefined && list.length < spec.min) list.push(defaultFor(item))
    return list
  }
  return given
}

/** Every input at its start: the preset where it gave one, the default elsewhere; a key of the preset no input has is kept. */
export function startValues(
  specs: Record<string, FieldSpec>,
  preset: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...preset,
    ...Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, withDefaults(s, preset[k])])),
  }
}

/** Whether a field, or anything inside it, makes its own starting value. */
export function anyGenerated(spec: FieldSpec): boolean {
  return Boolean(
    spec.generate ||
      (spec.shape && Object.values(spec.shape).some(anyGenerated)) ||
      (spec.item && anyGenerated(spec.item)),
  )
}

/** How many generated values a field holds right now. */
export function generatedCount(spec: FieldSpec, value: unknown): number {
  if (spec.generate) return 1
  if (spec.kind === 'object' && isObject(value))
    return Object.entries(spec.shape ?? {}).reduce(
      (n, [k, s]) => n + generatedCount(s, value[k]),
      0,
    )
  if (spec.kind === 'array' && Array.isArray(value) && spec.item) {
    const item = spec.item
    return value.reduce((n: number, x) => n + generatedCount(item, x), 0)
  }
  return 0
}

/** Another value for every generated field inside this one; what was typed into the others stays. */
export function regenerate(spec: FieldSpec, value: unknown): unknown {
  if (spec.generate) return generateFor(spec)
  if (spec.kind === 'object' && isObject(value))
    return {
      ...value,
      ...Object.fromEntries(
        Object.entries(spec.shape ?? {}).map(([k, s]) => [k, regenerate(s, value[k])]),
      ),
    }
  if (spec.kind === 'array' && Array.isArray(value) && spec.item) {
    const item = spec.item
    return value.map((x) => regenerate(item, x))
  }
  return value
}

/** The inputs in a line: `currency usd · travelers 3 · amount 2000 +1`. */
export function summarize(
  specs: Record<string, FieldSpec>,
  values: Record<string, unknown>,
  shown = 3,
): string {
  const bits = Object.entries(specs).map(([name, spec]) => {
    const label = spec.label ?? name
    const v = values[name]
    if (spec.kind === 'array') return `${label} ${Array.isArray(v) ? v.length : 0}`
    if (spec.kind === 'object') return label
    return `${label} ${short(v)}`
  })
  const more = bits.length - shown
  return bits.slice(0, shown).join(' · ') + (more > 0 ? ` +${more}` : '')
}
