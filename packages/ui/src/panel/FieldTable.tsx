import { useState } from 'preact/hooks'
import { inlineSummary } from '../markdown'
import {
  type Defs,
  describe,
  type JsonSchema,
  kindOf,
  type Prop,
  propsOf,
  typeInfo,
  unionFor,
  unwrap,
} from '../schema'

export interface Row {
  /** what the row is called in the table: a field's name, or a dotted path below the field that is open */
  name: string
  /** what an open field is looked up by */
  key: string
  /** 0 for a field of the object, 1 for what is under an open field; a table is never indented further */
  depth: 0 | 1
  type: string
  /** the whole text of a type shortened to fit */
  typeTitle?: string
  required: boolean
  description?: string
  enum?: string[]
  /** a heading for one variant of a union, with the fields of that variant under it */
  variant?: boolean
  /** the field has fields of its own to show, or variants */
  schema?: JsonSchema
}

/** The most rows one open field shows. */
const MAX_EXPANDED = 150
/** How many levels of objects one open field shows. */
const LEVELS = 3

const objectBranches = (union: NonNullable<ReturnType<typeof unionFor>>, defs: Defs) =>
  union.branches.filter((b) => kindOf(unwrap(b.schema, defs)) === 'object')

const tagText = (union: { tagProp?: string }, tag?: string) =>
  union.tagProp && tag !== undefined ? `${union.tagProp} = "${tag}"` : ''

/** The union a property is, or that the items of a property that is a list are. */
function unionOfProp(schema: JsonSchema, defs: Defs) {
  const u = unwrap(schema, defs)
  const isList = kindOf(u) === 'array'
  return { u, isList, union: unionFor(isList ? u.items : schema, defs) }
}

function heading(
  union: NonNullable<ReturnType<typeof unionFor>>,
  b: { name?: string; tag?: string },
  key: string,
): Row {
  const name = b.name ?? 'variant'
  return {
    name,
    key: `${key}/${name}`,
    depth: 1,
    type: tagText(union, b.tag),
    required: false,
    variant: true,
  }
}

function propRow(p: Prop, defs: Defs, name: string, depth: 0 | 1, key: string): Row {
  const u = unwrap(p.schema, defs)
  const info = typeInfo(p.schema, defs)
  return {
    name,
    key,
    depth,
    type: info.text,
    typeTitle: info.title,
    required: p.required,
    description: describe(u),
    enum: Array.isArray(u.enum) && u.enum.length <= 10 ? u.enum.map(String) : undefined,
    schema: openable(p.schema, defs) ? p.schema : undefined,
  }
}

/** Whether a field has anything to open: fields of an object (or of the objects of a list), or variants. */
function openable(schema: JsonSchema, defs: Defs): boolean {
  const { u, isList, union } = unionOfProp(schema, defs)
  if (union) return objectBranches(union, defs).length > 0
  const inner = isList ? unwrap(u.items, defs) : u
  return kindOf(inner) === 'object' && propsOf(inner, defs).length > 0
}

/** The rows below a field, as dotted paths from it, `level` levels of objects deep. */
function below(schema: JsonSchema | undefined, defs: Defs, prefix: string, level: number): Row[] {
  if (!schema || level >= LEVELS) return []
  const rows: Row[] = []
  for (const p of propsOf(schema, defs)) {
    const name = prefix ? `${prefix}.${p.name}` : p.name
    rows.push(propRow(p, defs, name, 1, name))
    rows.push(...inside(p.schema, defs, name, level + 1))
  }
  return rows
}

/** What a field holds: a heading and the fields of each variant of a union, else the fields of an object. */
function inside(schema: JsonSchema, defs: Defs, name: string, level: number): Row[] {
  const { u, isList, union } = unionOfProp(schema, defs)
  if (union) {
    return objectBranches(union, defs).flatMap((b) => [
      heading(union, b, name),
      ...below(b.schema, defs, name, level),
    ])
  }
  const inner = isList ? unwrap(u.items, defs) : u
  return kindOf(inner) === 'object' ? below(inner, defs, name, level) : []
}

/** The rows an open field shows. */
export function expansion(schema: JsonSchema, defs: Defs): Row[] {
  return inside(schema, defs, '', 0)
}

/** The variants of a union field, named, for when the field is closed: what it can be, without what is in it. */
function variantsOf(schema: JsonSchema, defs: Defs, key: string): Row[] {
  const { union } = unionOfProp(schema, defs)
  return union ? objectBranches(union, defs).map((b) => heading(union, b, key)) : []
}

/**
 * The fields of an object, or of the objects of a list, or the variants of a union with the fields of each, all
 * at the top: what is in a field is shown when the field is opened (see `expansion`).
 */
export function topRows(schema: JsonSchema | undefined, defs: Defs): Row[] {
  if (!schema) return []
  const { u, isList, union } = unionOfProp(schema, defs)
  if (union) {
    return objectBranches(union, defs).flatMap((b) => [
      { ...heading(union, b, ''), depth: 0 as const },
      ...propsOf(b.schema, defs).map((p) =>
        propRow(p, defs, p.name, 0, `${b.name ?? 'variant'}/${p.name}`),
      ),
    ])
  }
  const root = isList ? unwrap(u.items, defs) : u
  return propsOf(root, defs).map((p) => propRow(p, defs, p.name, 0, p.name))
}

function RowView({ r, open, onToggle }: { r: Row; open?: boolean; onToggle?: () => void }) {
  return (
    <tr class={r.variant ? 'variant' : undefined} style={`--indent:${r.depth * 16 + 8}px`}>
      <td style={{ paddingLeft: `${r.depth * 16 + 8}px` }}>
        {r.variant ? (
          <span class="variant-name">{r.name}</span>
        ) : (
          <>
            {onToggle ? (
              <button
                type="button"
                class={`expand ${open ? 'open' : ''}`}
                aria-expanded={open}
                aria-label={`${open ? 'Hide' : 'Show'} what is in ${r.name}`}
                onClick={onToggle}
              >
                ▸
              </button>
            ) : (
              <span class="expand gap" />
            )}
            <code>{r.name}</code>
          </>
        )}
        {r.required && (
          <span class="req" title="required">
            *
          </span>
        )}
      </td>
      <td>
        {r.type && (
          <span class="chip" title={r.typeTitle}>
            {r.type}
          </span>
        )}
      </td>
      <td>
        <span
          class="doc-inline wrap"
          dangerouslySetInnerHTML={{ __html: inlineSummary(r.description, 220) }}
        />
        {r.enum && (
          <span class="field-doc-enum">
            {' '}
            {r.enum.map((v) => (
              <code>{v}</code>
            ))}
          </span>
        )}
      </td>
    </tr>
  )
}

/** A row to draw: a field of the table, what is under it, or a count of what is left out. */
export type Shown = { row: Row; under?: boolean } | { more: number; key: string }

/** What the table shows with the fields in `opened` open: their fields, or for a closed union field, its variants. */
export function visibleRows(
  schema: JsonSchema | undefined,
  defs: Defs,
  opened: ReadonlySet<string>,
): Shown[] {
  return topRows(schema, defs).flatMap((row): Shown[] => {
    const out: Shown[] = [{ row }]
    if (!row.schema) return out
    const more = opened.has(row.key)
      ? expansion(row.schema, defs)
      : variantsOf(row.schema, defs, row.key)
    for (const m of more.slice(0, MAX_EXPANDED)) out.push({ row: m, under: true })
    if (more.length > MAX_EXPANDED)
      out.push({ more: more.length - MAX_EXPANDED, key: `${row.key}>more` })
    return out
  })
}

export function FieldTable({ schema, defs }: { schema?: JsonSchema; defs: Defs }) {
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const shown = visibleRows(schema, defs, opened)
  if (shown.length === 0) return null
  const toggle = (key: string) =>
    setOpened((s) => {
      const next = new Set(s)
      if (!next.delete(key)) next.add(key)
      return next
    })
  let parent = ''
  return (
    <table class="fields">
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((s) => {
          if ('more' in s)
            return (
              <tr key={s.key}>
                <td colSpan={3} class="muted">
                  +{s.more} more fields in the spec
                </td>
              </tr>
            )
          if (!s.under) parent = s.row.key
          const key = s.under ? `${parent}>${s.row.key}` : s.row.key
          const row = s.row
          return (
            <RowView
              key={key}
              r={row}
              open={opened.has(row.key)}
              onToggle={!s.under && row.schema ? () => toggle(row.key) : undefined}
            />
          )
        })}
      </tbody>
    </table>
  )
}
