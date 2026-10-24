// Tiny Storybook-style controls DSL: runtime descriptors + inferred value types.

export interface Control<T = unknown> {
  readonly kind:
    | 'text'
    | 'number'
    | 'boolean'
    | 'date'
    | 'select'
    | 'multiselect'
    | 'object'
    | 'array'
  readonly opts: Record<string, any>
  /** Phantom type carrier. */
  readonly _type?: T
}

export type Controls = Record<string, Control<any>>
export type InferControls<P> = { [K in keyof P]: P[K] extends Control<infer T> ? T : never }

interface SelectOpts<O, V> {
  /** shown beside the control in the UI */
  description?: string
  label?: (o: O) => string
  value?: (o: O) => V
  default?: number | V | ((options: readonly O[]) => V)
}

/** A starting value, or a function that makes one each time it is needed (a faker value, today's date). */
export type Default<T> = T | (() => T)

/** Whether a control's starting value is made fresh each time, so a UI can offer to make another. */
export const isGenerated = (ctl: Control): boolean => typeof ctl.opts.default === 'function'

function startingValue<T>(d: Default<T> | undefined): T | undefined {
  return typeof d === 'function' ? (d as () => T)() : d
}

export const c = {
  text: (
    o: { default?: Default<string>; label?: string; description?: string } = {},
  ): Control<string> => ({
    kind: 'text',
    opts: o,
  }),
  number: (
    o: {
      default?: Default<number>
      min?: number
      max?: number
      label?: string
      description?: string
    } = {},
  ): Control<number> => ({
    kind: 'number',
    opts: o,
  }),
  boolean: (
    o: { default?: Default<boolean>; label?: string; description?: string } = {},
  ): Control<boolean> => ({
    kind: 'boolean',
    opts: o,
  }),
  date: (
    o: { default?: Default<string>; label?: string; description?: string } = {},
  ): Control<string> => ({
    kind: 'date',
    opts: o,
  }),
  select: <const O, V = O>(
    options: readonly O[],
    o: SelectOpts<O, V> = {},
  ): Control<NoInfer<V>> => ({
    kind: 'select',
    opts: { ...o, options },
  }),
  multiselect: <const O, V = O>(
    options: readonly O[],
    o: SelectOpts<O, V> = {},
  ): Control<NoInfer<V>[]> => ({
    kind: 'multiselect',
    opts: { ...o, options },
  }),
  /** A group of fields; its `label` heads the row when objects of the same shape are shown as one table. */
  object: <S extends Controls>(
    shape: S,
    o: { label?: string; description?: string } = {},
  ): Control<InferControls<S>> => ({
    kind: 'object',
    opts: { ...o, shape },
  }),
  /** A list of `min` to `max` items, each made from the item's own defaults when nothing is given. */
  array: <T>(
    item: Control<T>,
    o: {
      /** the starting list, or a function that makes it; an item may name only some fields, the rest start from their own defaults */
      default?: Default<Partial<T>[]>
      min?: number
      max?: number
      label?: string
      description?: string
    } = {},
  ): Control<T[]> => ({ kind: 'array', opts: { ...o, item } }),
}

export class ControlError extends Error {}

function optionValue(ctl: Control, option: unknown): unknown {
  const fn = ctl.opts.value as ((o: unknown) => unknown) | undefined
  return fn ? fn(option) : option
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** Resolve one control to a value: given > default > first option / empty. */
export function resolveControl(name: string, ctl: Control, given: unknown): unknown {
  switch (ctl.kind) {
    case 'select': {
      const options = ctl.opts.options as unknown[]
      if (options.length === 0) throw new ControlError(`No options available for "${name}"`)
      const values = options.map((o) => optionValue(ctl, o))
      if (given !== undefined) {
        if (!values.some((v) => same(v, given))) {
          throw new ControlError(`Value for "${name}" is not one of the available options`)
        }
        return given
      }
      const d = ctl.opts.default
      if (
        typeof d === 'number' &&
        Number.isInteger(d) &&
        d >= 0 &&
        d < values.length &&
        !(typeof values[0] === 'number')
      )
        return values[d]
      if (typeof d === 'function') return d(options)
      // a starting value that is not one of the options means nothing (`default: 0` on pet ids is the first pet, not a
      // pet numbered 0): the first option is the default
      if (d !== undefined && values.some((v) => same(v, d))) return d
      return values[0]
    }
    case 'multiselect': {
      const options = ctl.opts.options as unknown[]
      if (given !== undefined) return given
      const d = ctl.opts.default
      if (typeof d === 'function') return d(options)
      return d ?? []
    }
    case 'object': {
      const shape = ctl.opts.shape as Controls
      const g = (given ?? {}) as Record<string, unknown>
      return Object.fromEntries(
        Object.entries(shape).map(([k, v]) => [k, resolveControl(`${name}.${k}`, v, g[k])]),
      )
    }
    case 'array': {
      const { min, max } = ctl.opts
      // nothing given: the list starts at its minimum, each item made from its own defaults
      const v = (given ??
        startingValue(ctl.opts.default) ??
        Array.from({ length: min ?? 0 })) as unknown[]
      if (min !== undefined && v.length < min)
        throw new ControlError(`"${name}" needs at least ${min} items`)
      if (max !== undefined && v.length > max)
        throw new ControlError(`"${name}" allows at most ${max} items`)
      return v.map((item, i) => resolveControl(`${name}[${i}]`, ctl.opts.item, item))
    }
    case 'boolean':
      return given ?? startingValue(ctl.opts.default) ?? false
    case 'number':
      return given ?? startingValue(ctl.opts.default) ?? 0
    default:
      return given ?? startingValue(ctl.opts.default) ?? ''
  }
}

export function resolveControls(
  controls: Controls,
  given: Record<string, unknown> = {},
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(controls).map(([k, ctl]) => [k, resolveControl(k, ctl, given[k])]),
  )
}

/** Serializable description of one control, for a UI to render an input step. */
function describeControl(name: string, ctl: Control): Record<string, unknown> {
  const text = (k: string) => (typeof ctl.opts[k] === 'string' ? { [k]: ctl.opts[k] } : {})
  const meta = { ...text('label'), ...text('description') }
  if (ctl.kind === 'select' || ctl.kind === 'multiselect') {
    const labelFn = ctl.opts.label as ((o: unknown) => string) | undefined
    const options = (ctl.opts.options as unknown[]).map((o) => ({
      label: labelFn ? labelFn(o) : String(optionValue(ctl, o)),
      value: optionValue(ctl, o),
    }))
    let initial: unknown
    try {
      initial = resolveControl(name, ctl, undefined)
    } catch {
      /* no options: nothing to start from */
    }
    return {
      kind: ctl.kind,
      options,
      ...(initial !== undefined ? { default: initial } : {}),
      ...meta,
    }
  }
  if (ctl.kind === 'object')
    return {
      kind: 'object',
      shape: Object.fromEntries(
        Object.entries(ctl.opts.shape as Controls).map(([k, v]) => [k, describeControl(k, v)]),
      ),
      ...meta,
    }
  if (ctl.kind === 'array')
    return {
      kind: 'array',
      item: describeControl(name, ctl.opts.item),
      default: startingValue(ctl.opts.default),
      min: ctl.opts.min,
      max: ctl.opts.max,
      ...meta,
    }
  return {
    kind: ctl.kind,
    default: startingValue(ctl.opts.default),
    generated: isGenerated(ctl),
    ...(ctl.opts.min !== undefined ? { min: ctl.opts.min } : {}),
    ...(ctl.opts.max !== undefined ? { max: ctl.opts.max } : {}),
    ...meta,
  }
}

/** Serializable description for a UI to render an input step. */
export function describeControls(controls: Controls) {
  return Object.fromEntries(
    Object.entries(controls).map(([k, ctl]) => [k, describeControl(k, ctl)]),
  )
}
