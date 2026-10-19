// What a spec says about the value of a field, beyond its type: a description that names values, the same field's
// example elsewhere in the document, a pattern, and the limits a value must fit.

type Schema = Record<string, any>

/** Spec examples that are just the type name (Swagger editor defaults and the like) carry no information. */
export const PLACEHOLDER_VALUE = /^(string|str|<string>|\{string\}|string\d+|null)$/i

export function clearHintCaches() {
  regexes = new Map()
  made = new Map()
}

// ---------------- limits ----------------

let regexes = new Map<string, RegExp | null>()
function regexOf(pattern: string): RegExp | null {
  let re = regexes.get(pattern)
  if (re === undefined) {
    try {
      re = new RegExp(pattern)
    } catch {
      re = null
    }
    regexes.set(pattern, re)
  }
  return re
}

const FORMATS: Record<string, RegExp> = {
  'date-time': /^\d{4}-\d\d-\d\dT/,
  date: /^\d{4}-\d\d-\d\d$/,
  email: /^[^@\s]+@[^@\s]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  uri: /^[a-z][\w+.-]*:/i,
  url: /^[a-z][\w+.-]*:/i,
}

/** Whether `value` has the JSON type the schema declares and respects its limits (schemas with no plain `type` always fit). */
export function fits(schema: Schema, value: unknown): boolean {
  if (Array.isArray(schema.enum) && value !== null && !schema.enum.includes(value)) return false
  if (schema.const !== undefined && value !== schema.const) return false
  const type = Array.isArray(schema.type)
    ? schema.type.find((t: string) => t !== 'null')
    : schema.type
  if (value === null) return true
  switch (type) {
    case 'string': {
      if (typeof value !== 'string') return false
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return false
      if (schema.minLength !== undefined && value.length < schema.minLength) return false
      if (schema.pattern && !regexOf(schema.pattern)?.test(value)) return false
      const f = schema.format && FORMATS[schema.format]
      return !f || f.test(value)
    }
    case 'integer':
    case 'number':
      return (
        typeof value === 'number' &&
        (type === 'number' || Number.isInteger(value)) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum)
      )
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return typeof value === 'object' && !Array.isArray(value)
    default:
      return true
  }
}

/** Whether a null is allowed here: `nullable`, a `null` type, or a `null` branch. */
export function nullable(
  schema: Schema | undefined,
  resolve: (ref: string) => Schema | undefined,
  d = 0,
): boolean {
  if (!schema || d > 8) return false
  if (schema.$ref) return nullable(resolve(schema.$ref), resolve, d + 1)
  const type = schema.type
  return (
    schema.nullable === true ||
    type === 'null' ||
    (Array.isArray(type) && type.includes('null')) ||
    [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].some((b: Schema) =>
      nullable(b, resolve, d + 1),
    )
  )
}

/** The JSON kind a schema describes (following refs and taking the first branch of a union). */
function kindOf(
  s: Schema | undefined,
  resolve: (ref: string) => Schema | undefined,
  d = 0,
): string | undefined {
  if (!s || d > 8) return undefined
  if (s.$ref) return kindOf(resolve(s.$ref), resolve, d + 1)
  const first = s.anyOf?.[0] ?? s.oneOf?.[0] ?? s.allOf?.[0]
  if (first) return kindOf(first, resolve, d + 1)
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type
  return type ?? (s.properties ? 'object' : s.items ? 'array' : undefined)
}

/**
 * Whether a value a spec supplies satisfies its schema: required fields present, types, enums and limits
 * right. A spec example that does not (GitHub's often leave out a required field) is not shown as the answer.
 */
export function conforms(
  schema: Schema | undefined,
  value: unknown,
  resolve: (ref: string) => Schema | undefined,
  d = 0,
): boolean {
  if (!schema || d > 30) return true
  if (schema.$ref) return conforms(resolve(schema.$ref), value, resolve, d + 1)
  if (value === null) return nullable(schema, resolve)
  if (schema.allOf && !schema.allOf.every((b: Schema) => conforms(b, value, resolve, d + 1)))
    return false
  // the viewer checks a value against the first branch of its own kind, so that is the branch it has to fit
  const alts: Schema[] | undefined = schema.oneOf ?? schema.anyOf
  if (alts?.length) {
    const want = Array.isArray(value) ? 'array' : typeof value
    const same = (b: Schema) => {
      const k = kindOf(b, resolve)
      return k === want || (k === 'integer' && want === 'number')
    }
    if (!conforms(alts.find(same) ?? alts[0], value, resolve, d + 1)) return false
  }
  if (!fits(schema, value)) return false
  if (Array.isArray(value))
    return (
      !schema.items || value.slice(0, 3).every((x) => conforms(schema.items, x, resolve, d + 1))
    )
  if (typeof value === 'object') {
    const have = value as Record<string, unknown>
    if ((schema.required as string[] | undefined)?.some((k) => !(k in have))) return false
    const props = schema.properties as Record<string, Schema> | undefined
    return (
      !props ||
      Object.entries(have).every(([k, v]) => !props[k] || conforms(props[k], v, resolve, d + 1))
    )
  }
  return true
}

// ---------------- descriptions ----------------

const LIST =
  /(?:options are|possible values|allowed values|valid values)[^`"]{0,120}?[`"]([^`"\n]{1,80})[`"]/i
const DIRECT =
  /(?:can be(?: one of)?|one of|either|defaults? to|default:|e\.g\.,?|for example|such as)[\s:*(-]*[`"]([^`"\n]{1,80})[`"]/i
const NOT_A_VALUE = /^(true|false|null)$/i

/** A worked value after "E.g." that is not quoted (`E.g. 2023-12-31 for ...`). */
const WORKED = /\be\.g\.,?\s+(\d[\w:.+-]{3,30})/i

/** Standards a description cites, with the value that follows them. Only what the text itself says. */
const STANDARDS: [RegExp, (d: string) => string][] = [
  [/ISO 4217|three-letter[^.]{0,60}currency/i, (d) => (/upper ?case/i.test(d) ? 'USD' : 'usd')],
  [/ISO 3166-1|two-letter (?:ISO )?country code/i, () => 'US'],
  [/ISO 639|two-letter language code/i, () => 'en'],
  [/last (?:four|4) (?:digits|characters)/i, () => '4242'],
  [/\bYYYY-MM-DD\b/, () => '2024-05-14'],
  [/^(?:the )?id of\b|^(?:a )?unique identifier\b/i, () => 'a1b2c3d4'],
  [/^(?:the )?url\b/i, () => 'https://example.com/resource'],
  [/^(?:the )?(?:customer's )?email address\b/i, () => 'jane.doe@example.com'],
  [/^(?:the )?(?:customer's )?phone number\b/i, () => '+1-555-0100'],
  [
    /ISO 8601/i,
    (d) => (/\bdate\b/i.test(d) && !/time/i.test(d) ? '2024-05-14' : '2024-05-14T09:30:00Z'),
  ],
]

/** The value a description gives: one it names after a phrase like "Can be", "e.g." or "Defaults to" (`Defaults to the `id`` names none), or the standard it cites. */
export function fromDescription(description: unknown): string | undefined {
  if (typeof description !== 'string' || description.length < 8) return undefined
  const m = LIST.exec(description) ?? DIRECT.exec(description)
  const v = (m?.[1] ?? WORKED.exec(description)?.[1])?.trim()
  if (v && !NOT_A_VALUE.test(v)) return v
  for (const [re, value] of STANDARDS) if (re.test(description)) return value(description)
  return undefined
}

// ---------------- patterns ----------------

const CLASS_ESCAPES: Record<string, string> = {
  d: '1',
  w: 'a',
  s: ' ',
  D: 'a',
  W: '-',
  S: 'a',
  n: '\n',
  t: '\t',
  b: '',
  B: '',
}
let made = new Map<string, string | undefined>()

/** A string for a simple regex (literals, classes, groups, `|`, quantifiers); undefined when it cannot be sure. */
export function fromPattern(pattern: string): string | undefined {
  if (made.has(pattern)) return made.get(pattern)
  let out: string | undefined
  try {
    out = generate(pattern)
    if (!regexOf(pattern)?.test(out)) out = undefined
  } catch {
    out = undefined
  }
  made.set(pattern, out)
  return out
}

function generate(src: string): string {
  let i = 0
  const literal = (c: string | undefined) => (c === undefined ? '' : (CLASS_ESCAPES[c] ?? c))
  const klass = (): string => {
    let first: string | undefined
    if (src[i] === '^') i++
    while (i < src.length && (src[i] !== ']' || first === undefined)) {
      const c = src[i++] as string
      if (first === undefined) first = c === '\\' ? literal(src[i++]) : c
    }
    i++
    return first ?? ''
  }
  const seq = (): string => {
    let out = ''
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      const c = src[i++] as string
      if (c === '^' || c === '$') continue
      let atom: string
      if (c === '(') {
        if (src[i] === '?') {
          if (!src.startsWith('?:', i)) throw new Error('unsupported group')
          i += 2
        }
        atom = alt()
        i++
      } else if (c === '[') atom = klass()
      else if (c === '\\') atom = literal(src[i++])
      else if (c === '.') atom = 'a'
      else atom = c
      let times = 1
      const q = src[i]
      if (q === '?' || q === '*') {
        times = 0
        i++
      } else if (q === '+') i++
      else if (q === '{') {
        const m = /^\{(\d+)(?:,\d*)?\}/.exec(src.slice(i))
        if (!m) throw new Error('bad quantifier')
        times = Number(m[1])
        i += m[0].length
      }
      if (src[i] === '?') i++
      if (times > 256) throw new Error('too long')
      out += atom.repeat(times)
    }
    return out
  }
  const alt = (): string => {
    const first = seq()
    while (src[i] === '|') {
      i++
      seq()
    }
    return first
  }
  return alt()
}

// ---------------- the same field elsewhere in the spec ----------------

/**
 * The values the document gives a field of this name, most common first. `get` holds what the spec shows for it
 * (an example, a default); `weak` what it only allows or mentions (an enum value, a value a description names).
 */
export interface ValueIndex {
  get(key: string): unknown[]
  weak(key: string): unknown[]
}

/** Names too generic to carry over from one object to another (a Tag's `name` is not a Pet's). */
const GENERIC = new Set([
  'id',
  'name',
  'title',
  'label',
  'value',
  'key',
  'type',
  'kind',
  'description',
  'data',
  'message',
  'text',
  'body',
  'code',
  'error',
  'detail',
  'summary',
  'object',
  'url',
  'status',
  'state',
  'reason',
  'from',
  'to',
  'action',
  'event',
  'path',
  'content',
  'mode',
  'level',
  'role',
])

/** Descriptions worth reading for a value (most say nothing, so they skip the pattern matching). */
const MENTIONS = /`|"|ISO|e\.g|digits|YYYY|identifier|\bID of\b/i

/** A cap on nodes visited, so one huge inline example cannot dominate. */
const NODE_BUDGET = 60_000
const MAX_DEPTH = 8

/** Reads every field's example or default, and the leaves of spec examples, once and on first use. */
export function makeValueIndex(doc: unknown): ValueIndex {
  type Tally = Map<string, Map<string, [unknown, number]>>
  let ready: { strong: Map<string, unknown[]>; weak: Map<string, unknown[]> } | undefined
  const build = () => {
    const strong: Tally = new Map()
    const weak: Tally = new Map()
    let left = NODE_BUDGET
    const add = (into: Tally, key: string, v: unknown) => {
      if (!key || GENERIC.has(key.toLowerCase())) return
      if (typeof v === 'string' ? v === '' || PLACEHOLDER_VALUE.test(v) : typeof v !== 'number')
        return
      const seen = into.get(key) ?? new Map<string, [unknown, number]>()
      const id = JSON.stringify(v)
      const had = seen.get(id)
      if (had) had[1]++
      else seen.set(id, [v, 1])
      into.set(key, seen)
    }
    const known = (s: Schema) =>
      s.const ?? s.example ?? (Array.isArray(s.examples) ? s.examples[0] : undefined) ?? s.default
    /** What the spec only allows or mentions for a field: an enum value, or one its description names. */
    const mentioned = (key: string, s: Schema) => {
      const choice = Array.isArray(s.enum) ? s.enum.find((v: unknown) => v !== '') : undefined
      if (choice !== undefined) add(weak, key, choice)
      else if (typeof s.description === 'string' && MENTIONS.test(s.description))
        add(weak, key, fromDescription(s.description))
    }
    const leaves = (v: unknown, key: string, depth: number) => {
      if (--left < 0 || depth > MAX_DEPTH || v === null) return
      if (Array.isArray(v)) for (const x of v.slice(0, 3)) leaves(x, key, depth + 1)
      else if (typeof v === 'object')
        for (const [k, x] of Object.entries(v)) leaves(x, k, depth + 1)
      else add(strong, key, v)
    }
    const walk = (node: any, depth: number) => {
      if (--left < 0 || depth > 40 || node === null || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const x of node) walk(x, depth + 1)
        return
      }
      if (node.properties && typeof node.properties === 'object')
        for (const [k, s] of Object.entries<any>(node.properties))
          if (s && typeof s === 'object') {
            add(strong, k, known(s))
            mentioned(k, s)
          }
      if (typeof node.name === 'string' && node.in && node.schema) {
        add(strong, node.name, node.example ?? known(node.schema))
        mentioned(node.name, node.schema)
      }
      if (node.example !== undefined && typeof node.example === 'object')
        leaves(node.example, '', 0)
      if (node.examples && typeof node.examples === 'object')
        for (const e of Object.values<any>(node.examples).slice(0, 3))
          leaves(e && typeof e === 'object' && 'value' in e ? e.value : e, '', 0)
      for (const v of Object.values(node)) walk(v, depth + 1)
    }
    walk(doc, 0)
    const rank = (t: Tally) => {
      const out = new Map<string, unknown[]>()
      for (const [k, seen] of t)
        out.set(
          k,
          [...seen.values()].sort((a, b) => b[1] - a[1]).map(([v]) => v),
        )
      return out
    }
    return { strong: rank(strong), weak: rank(weak) }
  }
  const read = () => {
    ready ??= build()
    return ready
  }
  return {
    get: (key) => read().strong.get(key) ?? [],
    weak: (key) => read().weak.get(key) ?? [],
  }
}
