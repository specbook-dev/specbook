import { inlineSummary } from '../markdown'
import { type Defs, describe, type JsonSchema, kindOf, propsOf, unwrap } from '../schema'
import { type FieldSection, noteKey } from './fieldnotes-split'

interface Row {
  name: string
  depth: number
  type: string
  required: boolean
  description?: string
  enum?: string[]
}

const MAX_ROWS = 60

function typeOf(u: JsonSchema, defs: Defs): string {
  const kind = kindOf(u)
  if (kind === 'array') return `${kindOf(unwrap(u.items, defs))}[]`
  return u.format ? `${kind} · ${u.format}` : kind
}

export function flatten(schema: JsonSchema | undefined, defs: Defs, depth = 0, prefix = ''): Row[] {
  if (!schema || depth > 2) return []
  const rows: Row[] = []
  for (const p of propsOf(schema, defs)) {
    const u = unwrap(p.schema, defs)
    const name = prefix ? `${prefix}.${p.name}` : p.name
    rows.push({
      name,
      depth,
      type: typeOf(u, defs),
      required: p.required,
      description: describe(u),
      enum: Array.isArray(u.enum) && u.enum.length <= 10 ? u.enum.map(String) : undefined,
    })
    const nested = kindOf(u) === 'array' ? unwrap(u.items, defs) : u
    if (kindOf(nested) === 'object') rows.push(...flatten(nested, defs, depth + 1, name))
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
          <tr>
            <td style={{ paddingLeft: `${r.depth * 16 + 8}px` }}>
              <code>{r.name.split('.').pop()}</code>
              {r.required && (
                <span class="req" title="required">
                  *
                </span>
              )}
            </td>
            <td>
              <span class="chip">{r.type}</span>
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
