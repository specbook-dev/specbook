import { useRef, useState } from 'preact/hooks'
import {
  anyGenerated,
  defaultFor,
  type FieldSpec,
  generatedCount,
  generateFor,
  regenerate,
} from '../components/Fields'
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

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

interface Column {
  /** the field of an object this column shows; none for a list of plain values */
  key?: string
  label: string
  spec: FieldSpec
}

export type Block =
  | { kind: 'fields'; names: string[] }
  | { kind: 'objects'; names: string[]; columns: Column[] }
  | { kind: 'list'; name: string; columns: Column[] }

const columnsOf = (spec: FieldSpec): Column[] =>
  spec.kind === 'object' && spec.shape
    ? Object.entries(spec.shape).map(([key, s]) => ({ key, label: s.label ?? key, spec: s }))
    : [{ label: spec.label ?? 'Value', spec }]

const signature = (spec: FieldSpec) =>
  Object.entries(spec.shape ?? {})
    .map(([k, s]) => `${k}:${s.kind}`)
    .join(',')

/**
 * How the inputs are laid out, in the order they were declared: plain inputs are rows of one table, neighbouring groups
 * (`c.object`) that have the same fields are the rows of one table, and a list (`c.array`) is a table of its own.
 */
export function blocksOf(specs: Record<string, FieldSpec>): Block[] {
  const blocks: Block[] = []
  for (const [name, spec] of Object.entries(specs)) {
    const last = blocks[blocks.length - 1]
    if (spec.kind === 'array' && spec.item) {
      blocks.push({ kind: 'list', name, columns: columnsOf(spec.item) })
    } else if (spec.kind === 'object' && spec.shape && Object.keys(spec.shape).length > 0) {
      if (
        last?.kind === 'objects' &&
        signature(specs[last.names[0] as string] as FieldSpec) === signature(spec)
      )
        last.names.push(name)
      else blocks.push({ kind: 'objects', names: [name], columns: columnsOf(spec) })
    } else if (last?.kind === 'fields') last.names.push(name)
    else blocks.push({ kind: 'fields', names: [name] })
  }
  return blocks
}

/** A value and, when it has a generator, the die that makes another. */
function GenCell({
  name,
  spec,
  value,
  onChange,
  die = true,
}: {
  name: string
  spec: FieldSpec
  value: unknown
  onChange: (v: unknown) => void
  /** whether the cell has a die of its own; a field in a row of a group is made again by the row's die */
  die?: boolean
}) {
  const own = die && spec.generate
  return (
    <div class={own ? 'cell-gen' : undefined}>
      <ValueCell name={name} spec={spec} value={value} onChange={onChange} />
      {own && (
        <button
          type="button"
          class="gen"
          aria-label={`Generate ${spec.label ?? name}`}
          title="Make another value"
          onClick={() => onChange(generateFor(spec))}
        >
          <Die />
        </button>
      )}
    </div>
  )
}

interface Row {
  heading: string
  path: string
  spec: FieldSpec
  value: unknown
  onChange: (v: unknown) => void
  onRemove?: () => void
  removeDisabled?: boolean
}

/** Rows of one shape: a heading and a die for the row, then a cell for each field. Cards on a narrow screen. */
function GroupTable({
  caption,
  columns,
  rows,
  count,
}: {
  caption?: string
  columns: Column[]
  rows: Row[]
  count?: { name: string; value: number; min?: number; max?: number; onChange: (n: number) => void }
}) {
  const countRef = useRef<HTMLInputElement>(null)
  return (
    <div class="group-block">
      {(caption || count) && (
        <div class="group-head">
          <span class="group-caption">{caption}</span>
          {count && (
            <label class="group-count">
              <input
                key={count.value}
                ref={countRef}
                class="cell"
                type="number"
                aria-label={`${count.name} count`}
                defaultValue={String(count.value)}
                min={count.min}
                max={count.max}
                onChange={(e) => {
                  const n = Number((e.target as HTMLInputElement).value)
                  if (Number.isFinite(n)) count.onChange(n)
                }}
              />
              <span class="muted">
                {count.min ?? 0}–{count.max ?? '∞'}
              </span>
            </label>
          )}
        </div>
      )}
      <table class="group-table">
        <thead>
          <tr>
            <th class="g-row" />
            {columns.map((col) => (
              <th title={col.spec.description}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <th scope="row" class="g-row">
                <span class="g-heading">{row.heading}</span>
                <span class="g-actions">
                  {anyGenerated(row.spec) && (
                    <button
                      type="button"
                      class="gen"
                      aria-label={`Generate ${row.path}`}
                      title="Make new values for this row"
                      onClick={() => row.onChange(regenerate(row.spec, row.value))}
                    >
                      <Die />
                    </button>
                  )}
                  {row.onRemove && (
                    <button
                      type="button"
                      class="gen remove"
                      aria-label={`Remove ${row.path}`}
                      title="Remove"
                      disabled={row.removeDisabled}
                      onClick={() => {
                        row.onRemove?.()
                        requestAnimationFrame(() => countRef.current?.focus())
                      }}
                    >
                      ✕
                    </button>
                  )}
                </span>
              </th>
              {columns.map((col) => {
                const spec = col.key ? (row.spec.shape?.[col.key] ?? col.spec) : row.spec
                const obj = isObject(row.value) ? row.value : {}
                const value = col.key ? obj[col.key] : row.value
                const name = col.key ? `${row.path}.${col.key}` : row.path
                return (
                  <td class="g-val">
                    <span class="g-label" aria-hidden="true">
                      {col.label}
                    </span>
                    <GenCell
                      name={name}
                      spec={spec}
                      value={value}
                      die={false}
                      onChange={(v) => row.onChange(col.key ? { ...obj, [col.key]: v } : v)}
                    />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A list of groups: how many, and a row for each. Rows taken off by lowering the count come back if it is raised again. */
function ListBlock({
  name,
  spec,
  columns,
  value,
  onChange,
}: {
  name: string
  spec: FieldSpec
  columns: Column[]
  value: unknown
  onChange: (v: unknown) => void
}) {
  const trimmed = useRef<unknown[]>([])
  const item = spec.item as FieldSpec
  const list = Array.isArray(value) ? value : []
  const min = spec.min ?? 0
  const setCount = (asked: number) => {
    const n = Math.max(min, Math.min(spec.max ?? Number.POSITIVE_INFINITY, Math.round(asked)))
    if (n < list.length) {
      trimmed.current = [...list.slice(n), ...trimmed.current]
      onChange(list.slice(0, n))
    } else if (n > list.length) {
      const more = Array.from({ length: n - list.length }, () =>
        trimmed.current.length > 0 ? trimmed.current.shift() : defaultFor(item),
      )
      onChange([...list, ...more])
    } else onChange([...list])
  }
  return (
    <GroupTable
      caption={spec.label ?? name}
      columns={columns}
      count={{ name, value: list.length, min: spec.min, max: spec.max, onChange: setCount }}
      rows={list.map((v, i) => ({
        heading: `#${i + 1}`,
        path: `${name}[${i}]`,
        spec: item,
        value: v,
        onChange: (nv) => onChange(list.map((x, j) => (j === i ? nv : x))),
        onRemove: () => onChange(list.filter((_, j) => j !== i)),
        removeDisabled: list.length <= min,
      }))}
    />
  )
}

/**
 * A flow's controls (inputs, or the choices of an input step) as the same spreadsheet the request
 * parameters use: name, value, description. Groups and lists are tables of their own.
 */
export function ControlsGrid({ title, specs, values, onChange }: Props) {
  const names = Object.keys(specs)
  if (names.length === 0) return null
  const generated = names.reduce((n, k) => n + generatedCount(specs[k] as FieldSpec, values[k]), 0)
  const set = (name: string) => (v: unknown) => onChange({ ...values, [name]: v })
  return (
    <section class="grid controls-grid" aria-label={title}>
      <h3 class="controls-head">
        <span>{title}</span>
        {generated > 1 && (
          <button
            type="button"
            class="btn small gen-all"
            title="Make a new value for every generated input"
            onClick={() =>
              onChange({
                ...values,
                ...Object.fromEntries(
                  names.map((n) => [n, regenerate(specs[n] as FieldSpec, values[n])]),
                ),
              })
            }
          >
            <Die /> Generate all
          </button>
        )}
      </h3>
      {blocksOf(specs).map((block) => {
        if (block.kind === 'list') {
          const spec = specs[block.name] as FieldSpec
          return (
            <ListBlock
              name={block.name}
              spec={spec}
              columns={block.columns}
              value={values[block.name]}
              onChange={set(block.name)}
            />
          )
        }
        if (block.kind === 'objects')
          return (
            <GroupTable
              columns={block.columns}
              rows={block.names.map((name) => {
                const spec = specs[name] as FieldSpec
                return {
                  heading: spec.label ?? name,
                  path: name,
                  spec,
                  value: values[name],
                  onChange: set(name),
                }
              })}
            />
          )
        return (
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
              {block.names.map((name) => {
                const spec = specs[name] as FieldSpec
                return (
                  <tr key={name}>
                    <td class="g-key">
                      <span class="key">
                        <code>{spec.label ?? name}</code>
                      </span>
                    </td>
                    <td class="g-val">
                      <GenCell name={name} spec={spec} value={values[name]} onChange={set(name)} />
                    </td>
                    <td class="g-doc" title={spec.description}>
                      <span class="chip">{hint(spec)}</span> {spec.description}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )
      })}
    </section>
  )
}
