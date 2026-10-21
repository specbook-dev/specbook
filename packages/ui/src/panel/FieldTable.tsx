import { inlineSummary } from '../markdown'
import {
  type Defs,
  describe,
  type JsonSchema,
  kindOf,
  propsOf,
  typeInfo,
  unionFor,
  unwrap,
} from '../schema'
import { type FieldSection, noteKey } from './fieldnotes-split'

interface Row {
  name: string
  depth: number
  type: string
  /** the whole text of a type shortened to fit */
  typeTitle?: string
  required: boolean
  description?: string
  enum?: string[]
  /** a heading for one variant of a union, with the fields of that variant under it */
  variant?: boolean
}

const MAX_ROWS = 60

/**
 * The rows of a field table. `depth` is how far a row is indented; `level` how deep the schema has gone, which
 * is what is limited: a variant's heading is a row, not a level, so a union costs no depth of its own.
 */
export function flatten(
  schema: JsonSchema | undefined,
  defs: Defs,
  depth = 0,
  prefix = '',
  level = depth,
): Row[] {
  if (!schema || level > 2) return []
  const rows: Row[] = []
  for (const p of propsOf(schema, defs)) {
    const u = unwrap(p.schema, defs)
    const name = prefix ? `${prefix}.${p.name}` : p.name
    const info = typeInfo(p.schema, defs)
    rows.push({
      name,
      depth,
      type: info.text,
      typeTitle: info.title,
      required: p.required,
      description: describe(u),
      enum: Array.isArray(u.enum) && u.enum.length <= 10 ? u.enum.map(String) : undefined,
    })
    const isList = kindOf(u) === 'array'
    const union = unionFor(isList ? u.items : p.schema, defs)
    if (union) {
      // each variant under a heading that says what it is called and what its tag is
      for (const b of union.branches) {
        if (kindOf(unwrap(b.schema, defs)) !== 'object') continue
        rows.push({
          name: `${name}.${b.name ?? 'variant'}`,
          depth: depth + 1,
          type: union.tagProp && b.tag !== undefined ? `${union.tagProp} = "${b.tag}"` : '',
          required: false,
          variant: true,
        })
        rows.push(...flatten(b.schema, defs, depth + 2, name, level + 1))
      }
      continue
    }
    const nested = isList ? unwrap(u.items, defs) : u
    if (kindOf(nested) === 'object') rows.push(...flatten(nested, defs, depth + 1, name, level + 1))
  }
  return rows
}

export function FieldTable({
  schema,
  defs,
  section = 'data',
  notes,
}: {
  schema?: JsonSchema
  defs: Defs
  /** where these fields sit in the request, for looking up the project's notes */
  section?: FieldSection
  notes?: Map<string, string>
}) {
  const rows = flatten(schema, defs)
  if (rows.length === 0) return null
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
        {rows.slice(0, MAX_ROWS).map((r) => (
          <tr class={r.variant ? 'variant' : undefined}>
            <td style={{ paddingLeft: `${r.depth * 16 + 8}px` }}>
              {r.variant ? (
                <span class="variant-name">{r.name.split('.').pop()}</span>
              ) : (
                <code>{r.name.split('.').pop()}</code>
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
              {notes?.get(noteKey(section, r.name)) && (
                <div
                  class="field-note"
                  dangerouslySetInnerHTML={{
                    __html: notes.get(noteKey(section, r.name)) as string,
                  }}
                />
              )}
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
        ))}
        {rows.length > MAX_ROWS && (
          <tr>
            <td colSpan={3} class="muted">
              +{rows.length - MAX_ROWS} more fields in the spec
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
