import { type FieldSection, noteKey } from './panel/fieldnotes-split'
import {
  type Defs,
  describe,
  type JsonSchema,
  type KeyPath,
  kindOf,
  pathString,
  propsOf,
  schemaAt,
  unwrap,
} from './schema'

export interface FieldDoc {
  path: string
  type: string
  required: boolean
  enum?: string[]
  description?: string
  /** the project's own note for this field (HTML), shown after the spec's description */
  note?: string
  /** what the enclosing object says about itself, shown when the field has no description */
  parent?: string
  deprecated?: boolean
}

/** What the API documents about the field at `path` (relative to `prefix`, e.g. `['data']` for a body). */
export function fieldDoc(
  root: JsonSchema | undefined,
  defs: Defs,
  path: KeyPath,
  prefix: KeyPath = [],
): FieldDoc | undefined {
  if (!root) return undefined
  const full = [...prefix, ...path]
  const schema = full.length === 0 ? root : schemaAt(root, full, defs)
  if (!schema) return undefined
  const u = unwrap(schema, defs)
  // the cursor is on the outermost brace: say what the whole body is, when the spec does
  if (path.length === 0) {
    const text = typeof u.description === 'string' ? u.description.trim() : ''
    if (!text) return undefined
    return {
      path: typeof u.title === 'string' && u.title.trim() ? u.title.trim() : 'body',
      type: kindOf(u),
      required: false,
      description: text,
      deprecated: u.deprecated === true || undefined,
    }
  }
  const key = path[path.length - 1]
  const parent = schemaAt(root, full.slice(0, -1), defs)
  const kind = kindOf(u)
  const item = kind === 'array' ? kindOf(unwrap(u.items, defs)) : undefined
  return {
    path: pathString(path),
    type: item ? `${item}[]` : u.format ? `${kind} · ${u.format}` : kind,
    required:
      typeof key === 'string' &&
      !!parent &&
      propsOf(parent, defs).some((p) => p.name === key && p.required),
    enum: Array.isArray(u.enum) ? u.enum.map(String) : undefined,
    description: describe(u),
    parent: parent ? describe(unwrap(parent, defs)) : undefined,
    deprecated: u.deprecated === true || undefined,
  }
}

/** `metadata[order]` / `items[0][price]` -> ['metadata', 'order'] / ['items', 0, 'price'] */
export function keyPath(key: string): KeyPath {
  return (key.match(/[^[\]]+/g) ?? [key]).map((s) => (/^\d+$/.test(s) ? Number(s) : s))
}

/** Adds the project's note for `path` in `section` (see `README.md` field sections), when there is one. */
export function withNote(
  doc: FieldDoc | undefined,
  notes: Map<string, string> | undefined,
  section: FieldSection,
  path: string,
): FieldDoc | undefined {
  const note = doc && notes?.get(noteKey(section, path))
  return doc && note ? { ...doc, note } : doc
}
