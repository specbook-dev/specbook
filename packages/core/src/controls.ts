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

export const c = {
  text: (o: { default?: string; label?: string; description?: string } = {}): Control<string> => ({
    kind: 'text',
    opts: o,
  }),
  number: (
    o: { default?: number; min?: number; max?: number; label?: string; description?: string } = {},
  ): Control<number> => ({
    kind: 'number',
    opts: o,
  }),
  boolean: (
    o: { default?: boolean; label?: string; description?: string } = {},
  ): Control<boolean> => ({
    kind: 'boolean',
    opts: o,
  }),
  date: (o: { default?: string; label?: string; description?: string } = {}): Control<string> => ({
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
  object: <S extends Controls>(shape: S): Control<InferControls<S>> => ({
    kind: 'object',
    opts: { shape },
  }),
  array: <T>(
    item: Control<T>,
    o: { default?: T[]; min?: number; max?: number } = {},
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
      if (d !== undefined) return d
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
        Object.entries(shape).map(([k, v]) => [k, resolveControl(k, v, g[k])]),
      )
    }
    case 'array': {
      const v = (given ?? ctl.opts.default ?? []) as unknown[]
      const { min, max } = ctl.opts
      if (min !== undefined && v.length < min)
        throw new ControlError(`"${name}" needs at least ${min} items`)
      if (max !== undefined && v.length > max)
        throw new ControlError(`"${name}" allows at most ${max} items`)
      return v.map((item) => resolveControl(name, ctl.opts.item, item))
    }
    case 'boolean':
      return given ?? ctl.opts.default ?? false
    case 'number':
      return given ?? ctl.opts.default ?? 0
    default:
      return given ?? ctl.opts.default ?? ''
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

/** Serializable description for a UI to render an input step. */
export function describeControls(controls: Controls) {
  return Object.fromEntries(
    Object.entries(controls).map(([k, ctl]) => {
      if (ctl.kind === 'select' || ctl.kind === 'multiselect') {
        const labelFn = ctl.opts.label as ((o: unknown) => string) | undefined
        const options = (ctl.opts.options as unknown[]).map((o) => ({
          label: labelFn ? labelFn(o) : String(optionValue(ctl, o)),
          value: optionValue(ctl, o),
        }))
        return [k, { kind: ctl.kind, options }]
      }
      return [k, { kind: ctl.kind, default: ctl.opts.default }]
    }),
  )
}
