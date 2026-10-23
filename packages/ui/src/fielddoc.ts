import {
  type Defs,
  describe,
  type JsonSchema,
  type KeyPath,
  kindOf,
  nodeSchema,
  pathString,
  propsOf,
  schemaAt,
  typeInfo,
  valueAt,
} from './schema'

export interface FieldDoc {
  path: string
  type: string
  required: boolean
  enum?: string[]
  description?: string
  /** what the enclosing object says about itself, shown when the field has no description */
  parent?: string
  deprecated?: boolean
}

/**
 * What the API documents about the field at `path` (relative to `prefix`, e.g. `['data']` for a body). With
 * `value`, the body that `prefix` leads to, a union on the way is the variant that body names.
 */
export function fieldDoc(
  root: JsonSchema | undefined,
  defs: Defs,
  path: KeyPath,
  prefix: KeyPath = [],
  value?: unknown,
): FieldDoc | undefined {
  if (!root) return undefined
  const base = schemaAt(root, prefix, defs)
  if (!base) return undefined
  const at = (p: KeyPath) => schemaAt(base, p, defs, value)
  const schema = at(path)
  if (!schema) return undefined
  const u = nodeSchema(schema, valueAt(value, path), defs)
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
  const parent = at(path.slice(0, -1))
  return {
    path: pathString(path),
    type: typeInfo(schema, defs).text,
    required:
      typeof key === 'string' &&
      !!parent &&
      propsOf(nodeSchema(parent, valueAt(value, path.slice(0, -1)), defs), defs).some(
        (p) => p.name === key && p.required,
      ),
    enum: Array.isArray(u.enum) ? u.enum.map(String) : undefined,
    description: describe(u),
    parent: parent
      ? describe(nodeSchema(parent, valueAt(value, path.slice(0, -1)), defs))
      : undefined,
    deprecated: u.deprecated === true || undefined,
  }
}

/** `metadata[order]` / `items[0][price]` -> ['metadata', 'order'] / ['items', 0, 'price'] */
export function keyPath(key: string): KeyPath {
  return (key.match(/[^[\]]+/g) ?? [key]).map((s) => (/^\d+$/.test(s) ? Number(s) : s))
}
