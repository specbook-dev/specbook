// OpenAPI schema -> TypeScript type source, and deterministic example synthesis.

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

/** `status` is the response code being illustrated; -1 means "an error, code unknown" (a `default` response). */
function exampleString(key: string, format?: string, status?: number): string {
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
  const k = key.toLowerCase()
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
  if (/(^|_)(url|uri|href|link)$/.test(k) || k.endsWith('url')) {
    const base = k.replace(/_?(html_)?(url|uri|href|link)$/, '').replace(/_/g, '/')
    return `https://${k.includes('html') ? 'example.com' : 'api.example.com'}${base ? `/${base}` : ''}`
  }
  const rules: [RegExp, string][] = [
    [/e-?mail/, 'jane.doe@example.com'],
    [/^(login|username|user_name|handle)$/, 'octocat'],
    [/^first_?name$|^given_?name$/, 'Jane'],
    [/^last_?name$|^family_?name|^surname$/, 'Doe'],
    [/^(full_?name|display_?name|customer_?name)$/, 'Jane Doe'],
    [/^name$/, 'Example name'],
    [/^title$/, 'Example title'],
    [/^(description|summary|bio|about)$/, 'A short description of this item.'],
    [/^(body|content|text|comment|note|notes)$/, 'Example text content.'],
    [/^(message|detail|reason)$/, 'The operation completed successfully.'],
    [/^(error|error_?description)$/, 'Something went wrong.'],
    [/node_?id$/, 'MDQ6VXNlcjE='],
    [/(^|_)sha$|commit_?id$|^oid$/, 'a3f5c1e9b7d24c68f0e1a2b3c4d5e6f708192a3b'],
    [/^ref$/, 'refs/heads/main'],
    [/^(branch|default_branch)$/, 'main'],
    [/^(color|colour)$/, '0e8a16'],
    [/^language$/, 'TypeScript'],
    [/^(phone|phone_?number|mobile)$/, '+1-555-0100'],
    [/^(city|town)$/, 'Seattle'],
    [/^(state|province|region)$/, 'WA'],
    [/^(country|country_?code)$/, 'US'],
    [/^(postal_?code|zip|zip_?code)$/, '98101'],
    [/^(line1|address|street|address_?line_?1)$/, '123 Main Street'],
    [/^line2$/, 'Suite 400'],
    [/^currency$/, 'usd'],
    [/^(company|organization|org)$/, 'Example Inc.'],
    [/^(token|access_?token|api_?key|secret)$/, 'example_token_8f3a2b'],
    [/^(version|api_?version)$/, '1.0.0'],
    [/^(locale|lang)$/, 'en-US'],
    [/^(timezone|time_?zone)$/, 'America/Los_Angeles'],
    [/^(type|kind|category)$/, 'standard'],
    [/^(status|state)$/, 'active'],
    [/^object$/, 'object'],
    [/(^|_)id$/, 'a1b2c3d4'],
    [/(^|_)(at|date|time|timestamp)$/, '2024-05-14T09:30:00Z'],
  ]
  for (const [re, v] of rules) if (re.test(k)) return v
  return k ? `Example ${humanize(key)}` : 'Example text'
}

function exampleNumber(key: string, integer: boolean, min?: number): number {
  const k = key.toLowerCase()
  if (/(^|_)(created|updated|deleted|expires|arrival|paid|canceled)(_at)?$|_at$|timestamp$/.test(k))
    return 1715679000
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

const FAKE_BY_FORMAT: Record<string, string> = {
  email: 'internet.email',
  uuid: 'string.uuid',
  uri: 'internet.url',
  url: 'internet.url',
  hostname: 'internet.domainName',
  ipv4: 'internet.ipv4',
}

const FAKE_BY_NAME: [RegExp, string][] = [
  [/^(first_?name|given_?name)$/, 'person.firstName'],
  [/^(last_?name|family_?name|surname)$/, 'person.lastName'],
  [/^(full_?name|display_?name)$/, 'person.fullName'],
  [/^name$/, 'word.noun'],
  [/^(user_?name|login|handle)$/, 'internet.username'],
  [/^e?-?mail(_?address)?$/, 'internet.email'],
  [/^(phone|phone_?number|mobile)$/, 'phone.number'],
  [/^(city|town)$/, 'location.city'],
  [/^country$/, 'location.country'],
  [/^(postal_?code|zip|zip_?code)$/, 'location.zipCode'],
  [/^(line1|address|street|address_?line_?1)$/, 'location.streetAddress'],
  [/^(company|organization|org)$/, 'company.name'],
  [/^(title|subject)$/, 'lorem.sentence'],
  [/^(description|summary|bio|about|body|comment|note|notes|message)$/, 'lorem.sentence'],
  [/^(url|website|homepage)$/, 'internet.url'],
]

/** `{{faker.*}}` placeholder for a string leaf, chosen by format first and then by field name. */
export function fakerFor(key: string, format?: string): string | undefined {
  const path =
    (format && FAKE_BY_FORMAT[format]) ||
    FAKE_BY_NAME.find(([re]) => re.test(key.toLowerCase()))?.[1]
  return path ? `{{faker.${path}}}` : undefined
}

/** Deepest nesting of objects and arrays an example goes into before it settles for an empty one. */
const MAX_DEPTH = 6

/** Spec examples that are just the type name (Swagger editor defaults and the like) carry no information. */
const PLACEHOLDER_VALUE = /^(string|str|<string>|\{string\}|string\d+|null)$/i

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

/** Whether `value` has the JSON type the schema declares (schemas with no plain `type` always fit). */
function fits(schema: Schema, value: unknown): boolean {
  if (Array.isArray(schema.enum) && value !== null && !schema.enum.includes(value)) return false
  const type = Array.isArray(schema.type)
    ? schema.type.find((t: string) => t !== 'null')
    : schema.type
  if (value === null) return true
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'integer':
    case 'number':
      return typeof value === 'number'
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

/** A hard stop for chains of *required* objects, which is all an example follows past MAX_DEPTH. */
const HARD_DEPTH = 14

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
  fake = false,
  sparse = false,
): unknown {
  if (!schema) return null
  const again = (s: Schema | undefined, k = key, d = depth, sn = seen) =>
    synthesize(s, resolve, d, sn, k, status, fake, sparse)
  if (schema.$ref) {
    const target = resolve(schema.$ref)
    // a reference back into itself carries on as "required fields only", which the depth rules then end
    if (seen.includes(schema.$ref)) return again(target, key, Math.max(depth, MAX_DEPTH), [])
    return again(target, key, depth, [...seen, schema.$ref])
  }
  if (fake && schema.type === 'string' && !schema.enum) {
    const generated = fakerFor(key, schema.format)
    if (generated) return generated
  }
  // a spec example that contradicts its own schema (a string field whose example is an array) is ignored
  if (schema.example !== undefined && fits(schema, schema.example))
    return schema.enum
      ? schema.example
      : sanitizeExample(schema.example, key, schema.format, status)
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
  const pick = schema.oneOf?.[0] ?? schema.anyOf?.[0]
  if (pick) return again(pick)
  const type = Array.isArray(schema.type)
    ? schema.type.find((t: string) => t !== 'null')
    : schema.type
  switch (type) {
    case 'string':
      return exampleString(key, schema.format, status)
    case 'integer':
      return exampleNumber(key, true, schema.minimum)
    case 'number':
      return exampleNumber(key, false, schema.minimum)
    case 'boolean':
      return exampleBoolean(key)
    case 'array':
      if (depth >= MAX_DEPTH) return []
      return [again(schema.items, singular(key), depth + 1)]
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
        const keep = sparse ? sparseKeys(schema, props, resolve) : undefined
        for (const [k, v] of Object.entries<Schema>(props)) {
          if (keep && !keep.has(k)) continue
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
    const known = s?.example !== undefined || s?.default !== undefined || v.example !== undefined
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

  const rec = (s: Schema) => toJsonSchema(s, refPrefix)
  const withPlaceholder = (body: Schema): Schema => ({ ...meta, anyOf: [body, PLACEHOLDER] })

  if (schema.allOf) return { ...meta, allOf: schema.allOf.map(rec) }
  if (schema.oneOf) return { ...meta, oneOf: schema.oneOf.map(rec) }
  if (schema.anyOf) return { ...meta, anyOf: schema.anyOf.map(rec) }
  if (schema.enum) {
    const declared = Array.isArray(schema.type) ? schema.type[0] : schema.type
    const body: Schema = {
      ...(declared && declared !== 'string' ? { type: declared } : {}),
      enum: schema.nullable ? [...schema.enum, null] : schema.enum,
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
