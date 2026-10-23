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
  /** what the row is called: a field's name, or for an object under an open field its whole path (`address.county`) */
  name: string
  /** what an open field is looked up by */
  key: string
  /** the path of the field from the top of the table, which is what the fields of an object below it are named under */
  path: string
  /** 0 for the fields of the table and for an object under an open field, 1 for the other fields under it: never further */
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

type Union = NonNullable<ReturnType<typeof unionFor>>

const objectBranches = (union: Union, defs: Defs) =>
  union.branches.filter((b) => kindOf(unwrap(b.schema, defs)) === 'object')

const tagText = (union: { tagProp?: string }, tag?: string) =>
  union.tagProp && tag !== undefined ? `${union.tagProp} = "${tag}"` : ''

/** The union a property is, or that the items of a property that is a list are. */
function unionOfProp(schema: JsonSchema, defs: Defs) {
  const u = unwrap(schema, defs)
  const isList = kindOf(u) === 'array'
  return { u, isList, union: unionFor(isList ? u.items : schema, defs) }
}

function heading(union: Union, b: { name?: string; tag?: string }, key: string): Row {
  const name = b.name ?? 'variant'
  return {
    name,
    key: `${key}/${name}`,
    path: '',
    depth: 1,
    type: tagText(union, b.tag),
    required: false,
    variant: true,
  }
}

/** Whether a field has anything to open: fields of an object (or of the objects of a list), or variants. */
function openable(schema: JsonSchema, defs: Defs): boolean {
  const { u, isList, union } = unionOfProp(schema, defs)
  if (union) return objectBranches(union, defs).length > 0
  const inner = isList ? unwrap(u.items, defs) : u
  return kindOf(inner) === 'object' && propsOf(inner, defs).length > 0
}

function propRow(
  p: Prop,
  defs: Defs,
  at: { name: string; key: string; path: string; depth: 0 | 1 },
): Row {
  const u = unwrap(p.schema, defs)
  const info = typeInfo(p.schema, defs)
  return {
    ...at,
    type: info.text,
    typeTitle: info.title,
    required: p.required,
    description: describe(u),
    enum: Array.isArray(u.enum) && u.enum.length <= 10 ? u.enum.map(String) : undefined,
    schema: openable(p.schema, defs) ? p.schema : undefined,
  }
}

/**
 * The fields of an object as they sit under an open field: the plain ones indented one step, then each object
 * among them at the left under its whole path, to be opened in its turn. (An object's fields are never pushed
 * further in, so a table is as narrow at the bottom as at the top.)
 */
function fieldsUnder(obj: JsonSchema, defs: Defs, scope: string, path: string): Row[] {
  const props = propsOf(obj, defs)
  const plain = props.filter((p) => !openable(p.schema, defs))
  const nested = props.filter((p) => openable(p.schema, defs))
  const at = (p: Prop, depth: 0 | 1) => {
    const whole = path ? `${path}.${p.name}` : p.name
    return { name: depth === 0 ? whole : p.name, key: `${scope}>${p.name}`, path: whole, depth }
  }
  return [
    ...plain.map((p) => propRow(p, defs, at(p, 1))),
    ...nested.map((p) => propRow(p, defs, at(p, 0))),
  ]
}

/** What an open field holds: a heading and the fields of each variant of a union, else the fields of an object. */
export function expansion(row: Row, defs: Defs): Row[] {
  if (!row.schema) return []
  const { u, isList, union } = unionOfProp(row.schema, defs)
  if (union) {
    return objectBranches(union, defs).flatMap((b) => [
      heading(union, b, row.key),
      ...fieldsUnder(unwrap(b.schema, defs), defs, `${row.key}/${b.name ?? 'variant'}`, row.path),
    ])
  }
  const inner = isList ? unwrap(u.items, defs) : u
  return kindOf(inner) === 'object' ? fieldsUnder(inner, defs, row.key, row.path) : []
}

/** The variants of a union field, named, for when the field is closed: what it can be, without what is in it. */
function variantsOf(row: Row, defs: Defs): Row[] {
  if (!row.schema) return []
  const { union } = unionOfProp(row.schema, defs)
  return union ? objectBranches(union, defs).map((b) => heading(union, b, row.key)) : []
}

/**
 * The fields of an object, or of the objects of a list, or the variants of a union with the fields of each, all
 * at the left: what is in a field is shown when the field is opened (see `expansion`).
 */
export function topRows(schema: JsonSchema | undefined, defs: Defs): Row[] {
  if (!schema) return []
  const { u, isList, union } = unionOfProp(schema, defs)
  const top = (obj: JsonSchema, scope: string) =>
    propsOf(obj, defs).map((p) =>
      propRow(p, defs, { name: p.name, key: `${scope}${p.name}`, path: p.name, depth: 0 }),
    )
  if (union) {
    return objectBranches(union, defs).flatMap((b) => [
      { ...heading(union, b, ''), depth: 0 as const },
      ...top(unwrap(b.schema, defs), `${b.name ?? 'variant'}/`),
    ])
  }
  return top(isList ? unwrap(u.items, defs) : u, '')
}

function RowView({ r, open, onToggle }: { r: Row; open?: boolean; onToggle?: () => void }) {
  return (
    <tr class={r.variant ? 'variant' : undefined} style={`--indent:${r.depth * 16 + 8}px`}>
      <td style={{ paddingLeft: `${r.depth * 16 + 8}px` }}>
        {r.variant ? (
          <span class="variant-name">{r.name}</span>
        ) : (
          <span class="field-name">
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
            {r.required && (
              <span class="req" title="required">
                *
              </span>
            )}
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

/** A row to draw, or a count of what is left out. */
export type Shown = { row: Row } | { more: number; key: string }

/** What the table shows with the fields in `opened` open: what is under them, or for a closed union field, its variants. */
export function visibleRows(
  schema: JsonSchema | undefined,
  defs: Defs,
  opened: ReadonlySet<string>,
): Shown[] {
  const walk = (row: Row): Shown[] => {
    const out: Shown[] = [{ row }]
    if (!row.schema) return out
    const more = opened.has(row.key) ? expansion(row, defs) : variantsOf(row, defs)
    for (const m of more.slice(0, MAX_EXPANDED)) out.push(...walk(m))
    if (more.length > MAX_EXPANDED)
      out.push({ more: more.length - MAX_EXPANDED, key: `${row.key}>more` })
    return out
  }
  return topRows(schema, defs).flatMap(walk)
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
        {shown.map((s) =>
          'more' in s ? (
            <tr key={s.key}>
              <td colSpan={3} class="muted">
                +{s.more} more fields in the spec
              </td>
            </tr>
          ) : (
            <RowView
              key={s.row.key}
              r={s.row}
              open={opened.has(s.row.key)}
              onToggle={s.row.schema ? () => toggle(s.row.key) : undefined}
            />
          ),
        )}
      </tbody>
    </table>
  )
}
