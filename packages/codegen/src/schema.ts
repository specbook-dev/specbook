// OpenAPI schema -> TypeScript type source, and deterministic example synthesis.
import {
  clearHintCaches,
  fits,
  fromDescription,
  fromPattern,
  nullable,
  PLACEHOLDER_VALUE,
  type ValueIndex,
} from './hints'
import { flatProps, subtypeTag, type UnionContext, type UnionInfo, unionOf } from './union'

export type Schema = Record<string, any>

const IDENT = /^[A-Za-z_$][\w$]*$/

export function safeIdent(name: string): string {
  const cleaned = name.replace(/[^\w$]+(.)?/g, (_, c: string | undefined) =>
    c ? c.toUpperCase() : '',
  )
  const id = /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
  return id || '_'
}

export function pascal(name: string): string {
  const id = safeIdent(name)
  return id.charAt(0).toUpperCase() + id.slice(1)
}

export function propKey(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name)
}

export function jsdoc(schema: Schema | undefined, indent = ''): string {
  if (!schema) return ''
  const lines: string[] = []
  if (schema.title && schema.title !== schema.description) lines.push(schema.title)
  if (schema.description) lines.push(...String(schema.description).trim().split('\n'))
  if (schema.format) lines.push(`@format ${schema.format}`)
  if (schema.example !== undefined) lines.push(`@example ${JSON.stringify(schema.example)}`)
  if (schema.default !== undefined) lines.push(`@default ${JSON.stringify(schema.default)}`)
  if (schema.minimum !== undefined) lines.push(`@minimum ${schema.minimum}`)
  if (schema.maximum !== undefined) lines.push(`@maximum ${schema.maximum}`)
  if (schema.deprecated) lines.push('@deprecated')
  if (lines.length === 0) return ''
  const safe = lines.map((l) => l.replace(/\*\//g, '*\\/'))
  if (safe.length === 1) return `${indent}/** ${safe[0]} */\n`
  return `${indent}/**\n${safe.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`
}

export function refName(ref: string): string {
  return pascal(ref.split('/').pop() as string)
}

function paren(t: string): string {
  return /[|&]/.test(t) && !/^[([{]/.test(t) ? `(${t})` : t
}

export function tsType(schema: Schema | undefined, indent = '', p = ''): string {
  if (!schema || typeof schema !== 'object') return 'unknown'
  if (schema.$ref) return `${p}${refName(schema.$ref)}`
  let base: string
  if (schema.enum) {
    base = schema.enum.map((v: unknown) => JSON.stringify(v)).join(' | ') || 'never'
  } else if (schema.const !== undefined) {
    base = JSON.stringify(schema.const)
  } else if (schema.allOf) {
    base = schema.allOf.map((s: Schema) => paren(tsType(s, indent, p))).join(' & ')
  } else if (schema.oneOf || schema.anyOf) {
    base = (schema.oneOf ?? schema.anyOf)
      .map((s: Schema) => paren(tsType(s, indent, p)))
      .join(' | ')
  } else {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type]
    const parts = types.map((t) => single({ ...schema, type: t }, indent, p))
    base = [...new Set(parts)].join(' | ')
  }
  if (schema.nullable && !/\bnull\b/.test(base)) base += ' | null'
  return base
}

function single(schema: Schema, indent: string, p: string): string {
  switch (schema.type) {
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array':
      return `${paren(tsType(schema.items, indent, p))}[]`
    case 'object':
    case undefined:
      return objectType(schema, indent, p)
    default:
      return 'unknown'
  }
}

export function objectType(schema: Schema, indent = '', p = ''): string {
  const props = schema.properties as Record<string, Schema> | undefined
  const add = schema.additionalProperties
  if (!props && add === undefined && schema.type === undefined) return 'unknown'
  if (!props && (add === undefined || add === true)) return 'Record<string, unknown>'
  const required = new Set<string>(schema.required ?? [])
  const inner = `${indent}  `
  const members: string[] = []
  for (const [k, v] of Object.entries(props ?? {})) {
    members.push(
      `${jsdoc(v, inner)}${inner}${propKey(k)}${required.has(k) ? '' : '?'}: ${tsType(v, inner, p)}`,
    )
  }
  if (add && add !== true) {
    // With explicit properties, a typed index signature would conflict with them; keep it loose.
    const t = props && Object.keys(props).length > 0 ? 'unknown' : tsType(add, inner, p)
    members.push(`${inner}[key: string]: ${t}`)
  }
  if (members.length === 0) return 'Record<string, never>'
  return `{\n${members.join('\n')}\n${indent}}`
}

const humanize = (k: string) =>
  k
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase()

const singular = (k: string) =>
  k.endsWith('ies') ? `${k.slice(0, -3)}y` : k.endsWith('s') ? k.slice(0, -1) : k

/** A readable string for a property, chosen by format first, then by what the name suggests. */
const ERROR_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  401: 'Requires authentication',
  402: 'Payment required',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'Conflict',
  410: 'Gone',
  412: 'Precondition failed',
  422: 'Validation failed',
  429: 'Rate limit exceeded',
  500: 'Internal server error',
  502: 'Bad gateway',
  503: 'Service unavailable',
}

/** A value for a string `format`, when it has one. */
function byFormat(format?: string): string | undefined {
  switch (format) {
    case 'date-time':
      return '2024-05-14T09:30:00Z'
    case 'date':
      return '2024-05-14'
    case 'time':
      return '09:30:00'
    case 'email':
      return 'jane.doe@example.com'
    case 'uuid':
      return '3f2b1c9e-6c1a-4f55-9a43-1d2e8b7a4c10'
    case 'uri':
    case 'url':
      return 'https://example.com/resource'
    case 'hostname':
      return 'api.example.com'
    case 'ipv4':
      return '192.0.2.10'
    case 'ipv6':
      return '2001:db8::1'
    case 'byte':
      return 'ZXhhbXBsZQ=='
    case 'binary':
      return 'example'
  }
}

/** `status` is the response code being illustrated; -1 means "an error, code unknown" (a `default` response). */
function exampleString(key: string, format?: string, status?: number): string {
  return ruleString(key, format, status) ?? (key ? `Example ${humanize(key)}` : 'Example text')
}

/** What the name and format rules give, or undefined when none of them applies (what is left is the "Example …" text). */
function ruleString(key: string, format?: string, status?: number): string | undefined {
  const id = `${key}|${format}|${status}`
  const had = named.get(id)
  if (had !== undefined) return had === null ? undefined : had
  const out = chooseString(key, format, status)
  named.set(id, out ?? null)
  return out
}
let named = new Map<string, string | null>()

function chooseString(key: string, format?: string, status?: number): string | undefined {
  const formatted = byFormat(format)
  if (formatted !== undefined) return formatted
  const k = key.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase()
  const isError = status !== undefined && (status === -1 || status >= 400)
  if (isError) {
    if (/^(message|detail|reason|error_?description|title)$/.test(k)) {
      return status && status > 0
        ? (ERROR_MESSAGES[status] ?? 'Request failed')
        : 'The request could not be completed'
    }
    if (k === 'status') return status && status > 0 ? String(status) : 'error'
    if (/^(error|code)$/.test(k))
      return status && ERROR_MESSAGES[status]
        ? ERROR_MESSAGES[status].toLowerCase().replace(/\s+/g, '_')
        : 'request_failed'
    if (/^(documentation_?url)$/.test(k)) return 'https://docs.example.com/errors'
  }
  // a link to an image names its file type (`image_url_png`)
  const image = /^(.*?)_?(?:url|uri|link)_(png|svg|jpe?g|gif|webp)$/.exec(k)
  if (image) return `https://api.example.com/${image[1] || 'image'}.${image[2]}`
  if (/(^|_)(url|uri|href|link)$/.test(k) || k.endsWith('url')) {
    const base = k.replace(/_?(html_)?(url|uri|href|link)$/, '').replace(/_/g, '/')
    return `https://${k.includes('html') ? 'example.com' : 'api.example.com'}${base ? `/${base}` : ''}`
  }
  const rules: [RegExp, string][] = [
    [/e-?mail/, 'jane.doe@example.com'],
    [/^(login|username|user_name|handle)$/, 'octocat'],
    [/^first_?name$|^given_?name$/, 'Jane'],
    [/^last_?name$|^family_?name|^surname$/, 'Doe'],
    [/^(full_?name|display_?name|customer_?name)$|(^|_)holder_name$/, 'Jane Doe'],
    [/^name$/, 'Example name'],
    [/^title$/, 'Example title'],
    [/^(description|summary|bio|about)$/, 'A short description of this item.'],
    [/^(body|content|text|comment|note|notes)$|_text$/, 'Example text content.'],
    [/_html$/, '<p>Example text content.</p>'],
    [/^(homepage|website|site_url)$/, 'https://example.com'],
    [/^(message|detail|reason)$/, 'The operation completed successfully.'],
    [/^(error|error_?description)$/, 'Something went wrong.'],
    [/node_?id$/, 'MDQ6VXNlcjE='],
    [/(^|_)sha$|commit_?id$|^oid$/, 'a3f5c1e9b7d24c68f0e1a2b3c4d5e6f708192a3b'],
    [/^ref$/, 'refs/heads/main'],
    [/(^|_)branch$/, 'main'],
    [/^(color|colour)$/, '0e8a16'],
    [/^language$/, 'TypeScript'],
    [/^(phone|phone_?number|mobile)$/, '+1-555-0100'],
    [/^(city|town)$/, 'Seattle'],
    [/^(state|province|region)$/, 'WA'],
    [/^(country|country_?code)$/, 'US'],
    [/^(postal_?code|zip|zip_?code)$/, '98101'],
    [/^(line1|address|street|address_?line_?1)$/, '123 Main Street'],
    [/^line2$/, 'Suite 400'],
    [/(^|_)currency$/, 'usd'],
    [/^(company|organization)$/, 'Example Inc.'],
    [/^org$/, 'octo-org'],
    [/(^|_)(token|api_?key|secret)$/, 'example_token_8f3a2b'],
    [/^(version|api_?version)$/, '1.0.0'],
    [/^(locale|lang)$/, 'en-US'],
    [/^(timezone|time_?zone)$/, 'America/Los_Angeles'],
    [/^(type|kind|category)$/, 'standard'],
    [/^(status|state)$/, 'active'],
    [/^last4$/, '4242'],
    [/^owner$/, 'octocat'],
    [/^repo$/, 'hello-world'],
    [/(^|_)slug$/, 'my-slug'],
    [/fingerprint$/, 'Xt5EWLLDS7FJjR1c'],
    [/^number$/, '0001'],
    [/^(topic|tag)$/, 'api'],
    [/^object$/, 'object'],
    [/(^|_)id$/, 'a1b2c3d4'],
    [/(^|_)(at|date|time|timestamp)$/, '2024-05-14T09:30:00Z'],
  ]
  for (const [re, v] of rules) if (re.test(k)) return v
}

function exampleNumber(key: string, integer: boolean, min?: number): number {
  const k = key.toLowerCase()
  if (/(^|_)(created|updated|deleted|expires|arrival|paid|canceled)(_at)?$|_at$|timestamp$/.test(k))
    return 1715679000
  if (integer && /(^|_)(start|end|arrival|due|effective)_date$/.test(k)) return 1715679000
  if (/(^|_)(exp|expiry|expiration)_year$|^year$/.test(k)) return k === 'year' ? 2024 : 2030
  if (/(^|_)(exp|expiry|expiration)_month$/.test(k)) return 12
  if (k === 'month') return 5
  if (k === 'day') return 14
  if (/^(amount|total|subtotal|price|balance)(_.*)?$/.test(k)) return integer ? 2000 : 19.99
  if (/(^|_)(count|total_count|number)$/.test(k) || k.endsWith('_count')) return 3
  if (k === 'quantity' || k === 'qty') return 1
  if (/^(per_?page|limit|page_?size)$/.test(k)) return 30
  if (/^(page|offset)$/.test(k)) return 1
  if (/(^|_)(size|bytes|length)$/.test(k)) return 1024
  if (/(^|_)(lat|latitude)$/.test(k)) return 47.6062
  if (/(^|_)(lng|lon|longitude)$/.test(k)) return -122.3321
  if (/(^|_)id$/.test(k)) return min ?? 1001
  return min ?? (integer ? 1 : 1.5)
}

function exampleBoolean(key: string): boolean {
  return !/^(private|draft|archived|disabled|deleted|fork|locked|livemode|prerelease|site_admin|hireable|mergeable|merged|has_.*|is_.*(deleted|private|draft)|.*_(disabled|archived))$/.test(
    key.toLowerCase(),
  )
}

/** The value a schema's own example, `const` or (3.1) first `examples` entry gives. */
const exampleOf = (s: Schema | undefined) =>
  s?.const ?? s?.example ?? (Array.isArray(s?.examples) ? s.examples[0] : undefined)

/** A string for a field: what the spec says (description, the same field elsewhere), then the name rules, kept inside the schema's limits. */
function stringValue(schema: Schema, key: string, status?: number, index?: ValueIndex): string {
  const failing = status !== undefined && (status === -1 || status >= 400)
  const ok = (v: unknown): v is string => typeof v === 'string' && fits(schema, v)
  let v: unknown
  if (!failing) {
    let named = described.get(schema)
    if (named === undefined) {
      named = fromDescription(schema.description) ?? ''
      described.set(schema, named)
    }
    v = named || undefined
    if (!ok(v)) v = byFormat(schema.format)
    if (!ok(v) && index) v = index.get(key).find(ok)
  }
  if (!ok(v)) v = ruleString(key, schema.format, status)
  if (!ok(v) && !failing && index) v = index.weak(key).find(ok)
  if (!ok(v)) v = exampleString(key, schema.format, status)
  let out = v as string
  if (!fits(schema, out) && schema.pattern) out = fromPattern(schema.pattern) ?? out
  if (schema.maxLength !== undefined) out = out.slice(0, schema.maxLength)
  if (schema.minLength !== undefined && out.length < schema.minLength)
    out = out.padEnd(schema.minLength, out.slice(-1) || 'a')
  return out
}
let described = new WeakMap<object, string>()

/** Forgets what one generation run worked out, so a long-lived page or worker does not keep it. */
export function clearExampleCaches() {
  named = new Map()
  described = new WeakMap()
  inherited = new WeakMap()
  embedded = new WeakMap()
  clearHintCaches()
}

/** A number for a field, inside the schema's bounds and a multiple of `multipleOf`. */
function numberValue(schema: Schema, key: string, integer: boolean, index?: ValueIndex): number {
  const step = integer ? 1 : 0.01
  let lo = schema.minimum as number | undefined
  if (typeof schema.exclusiveMinimum === 'number') lo = schema.exclusiveMinimum + step
  else if (schema.exclusiveMinimum === true && lo !== undefined) lo += step
  let hi = schema.maximum as number | undefined
  if (typeof schema.exclusiveMaximum === 'number') hi = schema.exclusiveMaximum - step
  else if (schema.exclusiveMaximum === true && hi !== undefined) hi -= step
  const bounded = { type: integer ? 'integer' : 'number', minimum: lo, maximum: hi }
  if (schema.format === 'unix-time') return 1715679000
  const borrowed = index?.get(key).find((v) => fits(bounded, v))
  let n = (borrowed as number | undefined) ?? exampleNumber(key, integer, lo)
  if (lo !== undefined && n < lo) n = lo
  if (hi !== undefined && n > hi) n = hi
  const m = schema.multipleOf
  if (typeof m === 'number' && m > 0) {
    n = Math.ceil(n / m) * m
    if (hi !== undefined && n > hi) n = Math.floor(hi / m) * m
    n = Number(n.toFixed(10))
  }
  return n
}

/** A branch that has no description of its own reads the wrapper's (`anyOf: [{ type: string }, …]` described as "ID of the customer"). */
let inherited = new WeakMap<object, Schema>()
function describedAs(pick: Schema, wrapper: Schema): Schema {
  if (pick.$ref || pick.description !== undefined || !wrapper.description) return pick
  const had = inherited.get(pick)
  if (had) return had
  const merged = { ...pick, description: wrapper.description }
  inherited.set(pick, merged)
  return merged
}

/** An object with an `id` and several fields of its own: another resource, not a part of this one. */
const RESOURCE_FIELDS = 5

/**
 * Whether a schema is another resource embedded by value: a resource, a list of them, or a `{ data: [...] }`
 * wrapper around them. An expandable reference (`anyOf: [string, resource]`) is not: the string is what is shown.
 */
let embedded = new WeakMap<object, boolean>()
function embeds(
  s: Schema | undefined,
  resolve: (ref: string) => Schema | undefined,
  d = 0,
): boolean {
  if (!s || d > 6) return false
  const known = embedded.get(s)
  if (known !== undefined) return known
  let yes = false
  if (s.$ref) yes = embeds(resolve(s.$ref), resolve, d + 1)
  else if (s.allOf) yes = s.allOf.some((b: Schema) => embeds(b, resolve, d + 1))
  else if (s.oneOf || s.anyOf) {
    const branches: Schema[] = s.oneOf ?? s.anyOf
    yes = embeds(branches.find((b) => b.type !== 'null') ?? branches[0], resolve, d + 1)
  } else if (s.type === 'array') yes = embeds(s.items, resolve, d + 1)
  else if (s.properties) {
    const props = s.properties as Record<string, Schema>
    yes =
      ('id' in props && Object.keys(props).length >= RESOURCE_FIELDS) ||
      (!!props.data && embeds(props.data, resolve, d + 1))
  }
  embedded.set(s, yes)
  return yes
}

/** What an error response is made of besides its required fields and spec values. */
const ERROR_KEYS =
  /^(message|code|type|param|detail|errors?|documentation_url|doc_url|status|title|reason|error_description|request_id)$/i

/** The properties of an error object worth showing: required ones, spec values, and the usual error fields. */
function errorKeys(
  schema: Schema,
  props: Record<string, Schema>,
  resolve: (ref: string) => Schema | undefined,
): Set<string> {
  const keep = new Set<string>(schema.required ?? [])
  for (const [k, v] of Object.entries(props)) {
    const s = v.$ref ? resolve(v.$ref) : v
    if (
      ERROR_KEYS.test(k) ||
      exampleOf(s) !== undefined ||
      exampleOf(v) !== undefined ||
      s?.default !== undefined ||
      s?.enum?.length
    )
      keep.add(k)
  }
  return keep
}

/** Deepest nesting of objects and arrays an example goes into before it settles for an empty one. */
const MAX_DEPTH = 6

/**
 * Replaces placeholder leaves inside a spec-provided example (`"string"`, `"0"`) with a sensible value for the
 * field's name and format, and leaves everything meaningful alone.
 */
export function sanitizeExample(
  value: unknown,
  key = '',
  format?: string,
  status?: number,
): unknown {
  if (typeof value === 'string') {
    const t = value.trim()
    return t === '' || PLACEHOLDER_VALUE.test(t) ? exampleString(key, format, status) : value
  }
  if (Array.isArray(value))
    return value.map((v) => sanitizeExample(v, singular(key), format, status))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitizeExample(v, k, undefined, status)]),
    )
  return value
}

/** A hard stop for chains of *required* objects, which is all an example follows past MAX_DEPTH. */
const HARD_DEPTH = 14

/** How many items of a list of variants a success response shows: one of each kind, up to this many. */
const FANOUT = 3

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Writes the value that tells a variant apart (`kind: "album"`) into its example. The tag is the document's
 * `discriminator` value, not the name heuristic's guess; a property declared with other values keeps what it has.
 */
function applyTag(
  out: unknown,
  prop: string,
  value: string,
  ref: string,
  ctx: UnionContext,
): unknown {
  if (!isPlainObject(out)) return out
  const declared = flatProps(ctx.resolve(ref), ctx)[prop]
  if (declared?.enum && !declared.enum.includes(value)) return out
  if (declared?.const !== undefined && declared.const !== value) return out
  out[prop] = value
  return out
}

/**
 * The example of one alternative of a union (`u.branches[i]`), tagged with the value that tells it apart from the
 * others when the union says how. `synthesize` shows the first; a response with several variants writes each.
 */
export function synthesizeVariant(
  union: Schema,
  u: UnionInfo,
  i: number,
  resolve: (ref: string) => Schema | undefined,
  status?: number,
  sparse = false,
  index?: ValueIndex,
  depth = 0,
  seen: string[] = [],
  key = '',
): unknown {
  const b = u.branches[i] as UnionInfo['branches'][number]
  const out = synthesize(
    describedAs(b.schema, union),
    resolve,
    depth,
    seen,
    key,
    status,
    sparse,
    index,
  )
  return u.tagSource === 'discriminator' && u.tagProp && b.tag !== undefined && b.schema.$ref
    ? applyTag(out, u.tagProp, b.tag, b.schema.$ref, { resolve })
    : out
}

/**
 * Deterministic, human-readable example: example > default > enum[0] > heuristics by name/format.
 * With `fake`, free-form string leaves become `{{faker.*}}` placeholders so every play is fresh.
 * Always returns something valid for the schema's shape: a cycle or very deep branch ends in `{}` or `[]`,
 * never `null` (which fails validation wherever the schema is not nullable).
 */
export function synthesize(
  schema: Schema | undefined,
  resolve: (ref: string) => Schema | undefined,
  depth = 0,
  seen: string[] = [],
  key = '',
  status?: number,
  sparse = false,
  index?: ValueIndex,
): unknown {
  if (!schema) return null
  const again = (s: Schema | undefined, k = key, d = depth, sn = seen) =>
    synthesize(s, resolve, d, sn, k, status, sparse, index)
  const ctx: UnionContext = { resolve }
  if (schema.$ref) {
    const target = resolve(schema.$ref)
    // a reference back into itself carries on as "required fields only", which the depth rules then end
    const out = seen.includes(schema.$ref)
      ? again(target, key, Math.max(depth, MAX_DEPTH), [])
      : again(target, key, depth, [...seen, schema.$ref])
    // a variant of a family whose base holds the discriminator says which one it is
    const tag = subtypeTag(schema.$ref, ctx)
    return tag ? applyTag(out, tag.prop, tag.value, schema.$ref, ctx) : out
  }
  /** One alternative of a union, tagged when the union says how its alternatives are told apart. */
  const variant = (union: Schema, u: UnionInfo, i: number, k: string, d: number, sn: string[]) =>
    synthesizeVariant(union, u, i, resolve, status, sparse, index, d, sn, k)
  // a spec example that contradicts its own schema (a string field whose example is an array) is ignored
  const given = exampleOf(schema)
  if (given !== undefined && fits(schema, given))
    return schema.enum || schema.const !== undefined
      ? given
      : sanitizeExample(given, key, schema.format, status)
  if (schema.default !== undefined && fits(schema, schema.default)) return schema.default
  // an enum that lists "" (Stripe's way to clear a field) is not best shown as an empty value
  if (schema.enum?.length) return schema.enum.find((v: unknown) => v !== '') ?? schema.enum[0]
  if (schema.allOf) {
    const merged: Record<string, unknown> = {}
    for (const s of schema.allOf as Schema[]) {
      const v = again(s)
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(merged, v)
    }
    return merged
  }
  const branches: Schema[] | undefined = schema.oneOf ?? schema.anyOf
  // OpenAPI 3.1 writes an optional field as `anyOf: [{ type: 'null' }, ...]`: the first real branch shows the field
  const pick = branches?.find((b) => b.type !== 'null') ?? branches?.[0]
  if (pick) {
    const u = unionOf(schema, ctx)
    const at = u?.branches.findIndex((b) => b.schema === pick) ?? -1
    return u && at >= 0
      ? variant(schema, u, at, key, depth, seen)
      : again(describedAs(pick, schema))
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((t: string) => t !== 'null')
    : schema.type
  switch (type) {
    case 'string':
      return stringValue(schema, key, status, index)
    case 'integer':
      return numberValue(schema, key, true, index)
    case 'number':
      return numberValue(schema, key, false, index)
    case 'boolean':
      return exampleBoolean(key)
    case 'array': {
      if (depth >= MAX_DEPTH || schema.maxItems === 0) return []
      // a success response lists one of each kind when its items are a union (a request keeps one to edit)
      const items = schema.items as Schema | undefined
      const kinds =
        status !== undefined &&
        status >= 200 &&
        status < 400 &&
        !(items?.$ref && seen.includes(items.$ref))
          ? unionOf(items?.$ref ? resolve(items.$ref) : items, ctx)
          : undefined
      if (kinds) {
        const into = items?.$ref ? [...seen, items.$ref] : seen
        const union = (items?.$ref ? resolve(items.$ref) : items) as Schema
        const count = Math.max(
          1,
          Math.min(
            Math.max(Math.min(kinds.branches.length, FANOUT), schema.minItems ?? 0),
            schema.maxItems ?? 5,
            5,
          ),
        )
        return Array.from({ length: count }, (_, i) =>
          variant(union, kinds, i % kinds.branches.length, singular(key), depth + 1, into),
        )
      }
      // as many items as the schema asks for, distinct when it says they must be
      const first = again(schema.items, singular(key), depth + 1)
      const count = Math.min(Math.max(1, schema.minItems ?? 1), 5)
      return Array.from({ length: count }, (_, i) =>
        i && schema.uniqueItems && (typeof first === 'string' || typeof first === 'number')
          ? `${first}${i + 1}`
          : first,
      )
    }
    default: {
      if (schema.properties || type === 'object') {
        const out: Record<string, unknown> = {}
        const props = schema.properties ?? {}
        if (depth >= MAX_DEPTH) {
          // past the cut-off only what the schema requires is written, so the example stays valid
          if (depth >= HARD_DEPTH) return out
          for (const k of (schema.required ?? []) as string[])
            if (props[k]) out[k] = again(props[k], k, depth + 1)
          return out
        }
        // a `name` next to an email or first_name is a person's name, not a thing's
        const person = [
          'email',
          'first_name',
          'firstName',
          'last_name',
          'lastName',
          'username',
        ].some((p) => p in props)
        // an error is its required fields, spec values and the usual error fields, not every resource it could point to
        const failing = status !== undefined && (status === -1 || status >= 400)
        const keep = sparse
          ? sparseKeys(schema, props, resolve)
          : failing
            ? errorKeys(schema, props, resolve)
            : undefined
        for (const [k, v] of Object.entries<Schema>(props)) {
          if (keep && !keep.has(k)) continue
          // a server's own fields are not sent, and a secret it is given is not shown, unless the schema needs them
          const own = v.$ref ? resolve(v.$ref) : v
          const needed = (schema.required as string[] | undefined)?.includes(k)
          if (!needed && (status === undefined ? own?.readOnly : own?.writeOnly)) continue
          if (!needed && own?.deprecated) continue
          // another resource embedded by value is shown as what it is when absent: null where allowed, else left out
          if (!needed && status !== undefined && !failing && embeds(v, resolve)) {
            if (nullable(v, resolve)) out[k] = null
            continue
          }
          const hint = person && k === 'name' ? 'full_name' : k
          out[k] = again(v, hint, depth + 1)
        }
        return out
      }
      return null
    }
  }
}

/** Properties worth showing first when nothing is required; common identifying fields lead. */
const COMMON = [
  'name',
  'email',
  'description',
  'title',
  'type',
  'amount',
  'currency',
  'customer',
  'status',
]
const FALLBACK = 4

/**
 * Which properties a sparse example keeps: required ones, ones the spec gives an example, default or
 * closed set of values for, and, when that leaves nothing, a few plain scalar fields so the example still shows the shape.
 * Everything else stays available through the editor's autocomplete.
 */
function sparseKeys(
  schema: Schema,
  props: Record<string, Schema>,
  resolve: (ref: string) => Schema | undefined,
): Set<string> {
  const keep = new Set<string>(schema.required ?? [])
  for (const [k, v] of Object.entries(props)) {
    const s = v.$ref ? resolve(v.$ref) : v
    const known =
      exampleOf(s) !== undefined || s?.default !== undefined || exampleOf(v) !== undefined
    if (known || s?.enum?.length) keep.add(k)
  }
  // top up with a few plain scalars so the example still shows the shape of the object
  const names = Object.keys(props)
  const scalar = (k: string) => {
    const v = props[k] as Schema
    const s = (v.$ref ? resolve(v.$ref) : v) ?? {}
    return !s.properties && s.type !== 'object' && s.type !== 'array'
  }
  const ranked = [
    ...COMMON.filter((k) => names.includes(k)),
    ...names.filter((k) => !COMMON.includes(k)),
  ].filter(scalar)
  for (const k of ranked) {
    if (keep.size >= FALLBACK) break
    keep.add(k)
  }
  return keep
}

// ---------------- JSON Schema (for editor hover docs, completion and validation) ----------------

const PLACEHOLDER = { type: 'string', pattern: '^\\s*\\{\\{[^}]+\\}\\}\\s*$' }

/**
 * OpenAPI schema -> JSON Schema for the request editor. Every non-string leaf also accepts a
 * `"{{variable}}"` placeholder string, since requests are templates. Descriptions stay on the
 * outer node so hover docs keep working.
 */
export function toJsonSchema(schema: Schema | undefined, refPrefix: string): Schema {
  const out = convertSchema(schema, refPrefix)
  // `nullable` next to a $ref / allOf / oneOf / anyOf (OpenAPI 3.0) has no place of its own in JSON Schema
  if (
    schema &&
    typeof schema === 'object' &&
    schema.nullable === true &&
    (schema.$ref || schema.allOf || schema.oneOf || schema.anyOf)
  )
    return { anyOf: [out, { type: 'null' }] }
  return out
}

function convertSchema(schema: Schema | undefined, refPrefix: string): Schema {
  if (!schema || typeof schema !== 'object') return {}
  if (schema.$ref) {
    const out: Schema = { $ref: `${refPrefix}${refName(schema.$ref)}` }
    if (schema.description) out.description = schema.description
    return out
  }
  const meta: Schema = {}
  if (schema.title) meta.title = schema.title
  if (schema.description) meta.description = String(schema.description)
  if (schema.deprecated) meta.deprecated = true
  if (schema.default !== undefined) meta.default = schema.default
  if (schema.example !== undefined) meta.examples = [schema.example]
  // which branch a value is: kept, with its targets as the definition names the browser resolves
  if (typeof schema.discriminator?.propertyName === 'string')
    meta.discriminator = {
      propertyName: schema.discriminator.propertyName,
      ...(schema.discriminator.mapping
        ? {
            mapping: Object.fromEntries(
              Object.entries<unknown>(schema.discriminator.mapping)
                .filter(([, target]) => typeof target === 'string')
                .map(([key, target]) => [key, refName(target as string)]),
            ),
          }
        : {}),
    }

  const rec = (s: Schema) => toJsonSchema(s, refPrefix)
  const withPlaceholder = (body: Schema): Schema => ({ ...meta, anyOf: [body, PLACEHOLDER] })

  if (schema.allOf) return { ...meta, allOf: schema.allOf.map(rec) }
  if (schema.oneOf) return { ...meta, oneOf: schema.oneOf.map(rec) }
  if (schema.anyOf) return { ...meta, anyOf: schema.anyOf.map(rec) }
  if (schema.enum) {
    const declared = Array.isArray(schema.type) ? schema.type[0] : schema.type
    const body: Schema = {
      ...(declared && declared !== 'string' ? { type: declared } : {}),
      enum:
        schema.nullable || (Array.isArray(schema.type) && schema.type.includes('null'))
          ? [...schema.enum.filter((v: unknown) => v !== null), null]
          : schema.enum,
    }
    return schema.enum.every((v: unknown) => typeof v === 'string')
      ? withPlaceholder(body)
      : { ...meta, ...body }
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
  const nullable = schema.nullable || (Array.isArray(schema.type) && schema.type.includes('null'))
  const t = (name: string) => (nullable ? [name, 'null'] : name)
  switch (type) {
    case 'string':
      return {
        ...meta,
        type: t('string'),
        ...(schema.format ? { format: schema.format } : {}),
        ...(schema.maxLength !== undefined ? { maxLength: schema.maxLength } : {}),
      }
    case 'integer':
    case 'number':
    case 'boolean': {
      const body: Schema = { type: t(type) }
      if (schema.minimum !== undefined) body.minimum = schema.minimum
      if (schema.maximum !== undefined) body.maximum = schema.maximum
      return withPlaceholder(body)
    }
    case 'array':
      return { ...meta, type: t('array'), items: rec(schema.items ?? {}) }
    case 'null':
      // OpenAPI 3.1 writes an optional field as `anyOf: [{ type: integer }, { type: 'null' }]`: the branch must stay a null
      return { ...meta, type: 'null' }
    default: {
      if (!schema.properties && schema.additionalProperties === undefined && type !== 'object')
        return meta
      const props = Object.fromEntries(
        Object.entries<Schema>(schema.properties ?? {}).map(([k, v]) => [k, rec(v)]),
      )
      const out: Schema = { ...meta, type: t('object'), properties: props }
      if (schema.required?.length) out.required = schema.required
      if (schema.additionalProperties && schema.additionalProperties !== true) {
        out.additionalProperties = rec(schema.additionalProperties)
      } else if (schema.additionalProperties === true) {
        out.additionalProperties = true
      }
      return out
    }
  }
}
