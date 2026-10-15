// JSON Schema helpers for the annotated request/response views: resolve refs, unwrap the
// "{{variable}}" placeholder alternative, describe nodes, and validate a value against a schema.

export type JsonSchema = Record<string, any>
export type Defs = Record<string, any> | undefined

export type Kind =
  | 'object'
  | 'array'
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'null'
  | 'unknown'

export const TEMPLATE = /^\s*\{\{[^}]+\}\}\s*$/

export const isTemplate = (v: unknown): v is string => typeof v === 'string' && TEMPLATE.test(v)

function isPlaceholderSchema(s: JsonSchema): boolean {
  return s?.type === 'string' && typeof s.pattern === 'string' && s.pattern.includes('\\{\\{')
}

const META = ['title', 'description', 'default', 'examples', 'deprecated']

function withMeta(target: JsonSchema, outer: JsonSchema): JsonSchema {
  const out = { ...target }
  for (const k of META) if (outer[k] !== undefined && out[k] === undefined) out[k] = outer[k]
  return out
}

/** Follows `$ref` (into the service definitions) until a concrete schema is reached. */
export function resolveRef(schema: JsonSchema | undefined, defs: Defs): JsonSchema {
  let s: JsonSchema = schema ?? {}
  for (let i = 0; i < 12 && s.$ref; i++) {
    const name = String(s.$ref).split('/').pop() as string
    const target = defs?.$defs?.[name]
    if (!target) return { ...s, type: undefined }
    s = withMeta(target, s)
  }
  return s
}

/**
 * Resolves refs, drops the `"{{variable}}"` alternative, and flattens `allOf`.
 * For `oneOf`/`anyOf` it picks the first branch (callers that have a value use `pickBranch`).
 */
export function unwrap(schema: JsonSchema | undefined, defs: Defs, depth = 0): JsonSchema {
  let s = resolveRef(schema, defs)
  if (depth > 10) return s
  if (Array.isArray(s.anyOf)) {
    const branches = s.anyOf.filter((b: JsonSchema) => !isPlaceholderSchema(b))
    if (branches.length === 1) return unwrap(withMeta(branches[0], s), defs, depth + 1)
    if (branches.length > 1) return unwrap(withMeta(branches[0], s), defs, depth + 1)
  }
  if (Array.isArray(s.oneOf) && s.oneOf.length)
    return unwrap(withMeta(s.oneOf[0], s), defs, depth + 1)
  if (Array.isArray(s.allOf)) {
    const merged: JsonSchema = { ...s }
    Reflect.deleteProperty(merged, 'allOf')
    const props: Record<string, any> = { ...(merged.properties ?? {}) }
    const required = new Set<string>(merged.required ?? [])
    for (const part of s.allOf as JsonSchema[]) {
      const u = unwrap(part, defs, depth + 1)
      Object.assign(props, u.properties ?? {})
      for (const r of u.required ?? []) required.add(r)
      for (const k of META) if (u[k] !== undefined && merged[k] === undefined) merged[k] = u[k]
      if (u.type && !merged.type) merged.type = u.type
      if (u.items && !merged.items) merged.items = u.items
      if (u.enum && !merged.enum) merged.enum = u.enum
    }
    merged.properties = props
    merged.required = [...required]
    if (!merged.type && Object.keys(props).length) merged.type = 'object'
    s = merged
  }
  return s
}

export function kindOf(schema: JsonSchema): Kind {
  const t = Array.isArray(schema.type) ? schema.type.find((x: string) => x !== 'null') : schema.type
  if (
    t === 'object' ||
    t === 'array' ||
    t === 'string' ||
    t === 'integer' ||
    t === 'number' ||
    t === 'boolean'
  ) {
    return t
  }
  if (schema.properties) return 'object'
  if (schema.items) return 'array'
  if (schema.enum) return typeof schema.enum[0] === 'number' ? 'number' : 'string'
  return t === 'null' ? 'null' : 'unknown'
}

export function describe(schema: JsonSchema): string | undefined {
  const d = schema.description ?? schema.title
  return typeof d === 'string' && d.trim() ? d.trim() : undefined
}

/** First sentence/line of a description, for compact inline comments. */
export function summary(desc: string | undefined, max = 120): string | undefined {
  if (!desc) return undefined
  const line = desc.split(/\n+/)[0] as string
  const sentence = line.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? line
  const text = sentence.replace(/\s+/g, ' ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export interface Prop {
  name: string
  schema: JsonSchema
  required: boolean
}

export function propsOf(schema: JsonSchema, defs: Defs): Prop[] {
  const s = unwrap(schema, defs)
  const required = new Set<string>(s.required ?? [])
  return Object.entries<JsonSchema>(s.properties ?? {}).map(([name, sch]) => ({
    name,
    schema: sch,
    required: required.has(name),
  }))
}

export function childSchema(
  schema: JsonSchema,
  key: string | number,
  defs: Defs,
): JsonSchema | undefined {
  const s = unwrap(schema, defs)
  if (typeof key === 'number') return s.items
  if (s.properties?.[key]) return s.properties[key]
  if (s.additionalProperties && typeof s.additionalProperties === 'object')
    return s.additionalProperties
  return undefined
}

export interface Issue {
  path: string
  kind: 'type' | 'enum' | 'required' | 'extra' | 'range'
  message: string
}

const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** Pick the oneOf/anyOf branch whose primary type matches the value (falls back to the first). */
function pickBranch(schema: JsonSchema, value: unknown, defs: Defs): JsonSchema {
  const s = resolveRef(schema, defs)
  const branches = ((s.oneOf ?? s.anyOf) as JsonSchema[] | undefined)?.filter(
    (b) => !isPlaceholderSchema(b),
  )
  if (!branches?.length) return unwrap(s, defs)
  const want = typeName(value)
  const match = branches.find((b) => {
    const k = kindOf(unwrap(b, defs))
    return (
      k === want || (k === 'integer' && want === 'number') || (k === 'number' && want === 'number')
    )
  })
  return unwrap(withMeta(match ?? (branches[0] as JsonSchema), s), defs)
}

export interface ValidateOptions {
  /** Report object keys that the schema does not declare (response conformance). */
  reportExtra?: boolean
}

export function validate(
  value: unknown,
  schema: JsonSchema | undefined,
  defs: Defs,
  opts: ValidateOptions = {},
  path = '',
  depth = 0,
): Issue[] {
  if (!schema || depth > 12) return []
  if (isTemplate(value)) return [] // a {{variable}} stands for any value
  const s = pickBranch(schema, value, defs)
  const issues: Issue[] = []
  const at = path || '(root)'
  const nullable = Array.isArray(s.type) && s.type.includes('null')
  if (value === null) {
    if (!nullable && kindOf(s) !== 'null' && kindOf(s) !== 'unknown' && s.nullable !== true) {
      issues.push({ path: at, kind: 'type', message: `expected ${kindOf(s)}, got null` })
    }
    return issues
  }
  const kind = kindOf(s)
  const got = typeName(value)
  switch (kind) {
    case 'object': {
      if (got !== 'object')
        return [{ path: at, kind: 'type', message: `expected object, got ${got}` }]
      const obj = value as Record<string, unknown>
      const props = (s.properties ?? {}) as Record<string, JsonSchema>
      for (const r of (s.required ?? []) as string[]) {
        if (!(r in obj))
          issues.push({
            path: path ? `${path}.${r}` : r,
            kind: 'required',
            message: 'required field is missing',
          })
      }
      for (const [k, v] of Object.entries(obj)) {
        const p = path ? `${path}.${k}` : k
        if (props[k]) issues.push(...validate(v, props[k], defs, opts, p, depth + 1))
        else if (s.additionalProperties && typeof s.additionalProperties === 'object')
          issues.push(...validate(v, s.additionalProperties, defs, opts, p, depth + 1))
        else if (
          opts.reportExtra &&
          s.additionalProperties !== true &&
          Object.keys(props).length > 0
        )
          issues.push({ path: p, kind: 'extra', message: 'not in the spec' })
      }
      return issues
    }
    case 'array': {
      if (got !== 'array')
        return [{ path: at, kind: 'type', message: `expected array, got ${got}` }]
      ;(value as unknown[]).forEach((item, i) => {
        issues.push(...validate(item, s.items, defs, opts, `${path}[${i}]`, depth + 1))
      })
      return issues
    }
    case 'string': {
      if (got !== 'string')
        return [{ path: at, kind: 'type', message: `expected string, got ${got}` }]
      if (s.enum && !s.enum.includes(value)) {
        issues.push({ path: at, kind: 'enum', message: `must be one of: ${s.enum.join(' · ')}` })
      }
      return issues
    }
    case 'integer':
    case 'number': {
      if (got !== 'number')
        return [{ path: at, kind: 'type', message: `expected ${kind}, got ${got}` }]
      const n = value as number
      if (kind === 'integer' && !Number.isInteger(n))
        issues.push({ path: at, kind: 'type', message: 'expected an integer' })
      if (s.minimum !== undefined && n < s.minimum)
        issues.push({ path: at, kind: 'range', message: `must be ≥ ${s.minimum}` })
      if (s.maximum !== undefined && n > s.maximum)
        issues.push({ path: at, kind: 'range', message: `must be ≤ ${s.maximum}` })
      if (s.enum && !s.enum.includes(n))
        issues.push({ path: at, kind: 'enum', message: `must be one of: ${s.enum.join(' · ')}` })
      return issues
    }
    case 'boolean':
      return got === 'boolean'
        ? []
        : [{ path: at, kind: 'type', message: `expected boolean, got ${got}` }]
    default:
      return []
  }
}

export type KeyPath = (string | number)[]

/** A path such as "data.tags[0].id", the same format `validate` uses for issue paths. */
export const pathString = (p: KeyPath): string =>
  p.reduce<string>(
    (acc, k) => (typeof k === 'number' ? `${acc}[${k}]` : acc ? `${acc}.${k}` : String(k)),
    '',
  )

/**
 * For every line of a JSON document, the path of the key/element that starts on it (or undefined).
 * Tolerates incomplete or invalid JSON, so annotations keep working while the user types.
 */
export function linePaths(text: string): (KeyPath | undefined)[] {
  interface Box {
    type: 'obj' | 'arr'
    path: KeyPath
    key?: string
    idx: number
  }
  const out: (KeyPath | undefined)[] = [undefined]
  const stack: Box[] = []
  let line = 0
  const set = (p: KeyPath) => {
    if (out[line] === undefined) out[line] = p
  }
  const top = () => stack[stack.length - 1]
  const childPath = (b: Box | undefined): KeyPath | undefined =>
    !b
      ? []
      : b.type === 'arr'
        ? [...b.path, b.idx]
        : b.key !== undefined
          ? [...b.path, b.key]
          : undefined

  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (c === '\n') {
      line++
      out[line] = undefined
    } else if (c === '"') {
      let j = i + 1
      let str = ''
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          str += text[j + 1] ?? ''
          j += 2
        } else str += text[j++]
      }
      let k = j + 1
      while (k < text.length && /\s/.test(text[k] as string) && text[k] !== '\n') k++
      const t = top()
      if (t?.type === 'obj' && text[k] === ':') {
        t.key = str
        set([...t.path, str])
      } else if (t?.type === 'arr') set([...t.path, t.idx])
      i = j
    } else if (c === '{' || c === '[') {
      const t = top()
      const p = childPath(t)
      if (p) set(p)
      stack.push({ type: c === '{' ? 'obj' : 'arr', path: p ?? [], idx: 0 })
    } else if (c === '}' || c === ']') {
      stack.pop()
      const t = top()
      if (t?.type === 'arr') t.idx++
    } else if (c === ',') {
      const t = top()
      // object commas need no bookkeeping; scalar array elements advance the index where they end
      void t
    } else if (/[-\d]|[tfn]/.test(c)) {
      const t = top()
      if (t?.type === 'arr') {
        set([...t.path, t.idx])
        // scalar element: advance the index at the next comma
        let j = i
        while (j < text.length && !/[,\]\n]/.test(text[j] as string)) j++
        if (text[j] === ',') t.idx++
        i = j - 1
      }
    }
  }
  return out
}

export function schemaAt(
  root: JsonSchema | undefined,
  path: KeyPath,
  defs: Defs,
): JsonSchema | undefined {
  let s = root
  for (const k of path) {
    if (!s) return undefined
    s = childSchema(s, k, defs)
  }
  return s
}
