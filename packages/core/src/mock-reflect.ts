const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const scalar = (v: unknown) => ['string', 'number', 'boolean'].includes(typeof v)

/** Request values come out of the proxy as strings; keep the response field's own type. */
function coerce(value: unknown, like: unknown): unknown {
  if (
    typeof like === 'number' &&
    typeof value === 'string' &&
    value.trim() !== '' &&
    !Number.isNaN(Number(value))
  )
    return Number(value)
  if (typeof like === 'string' && typeof value === 'number') return String(value)
  return value
}

function fromBody(template: unknown, body: unknown): unknown {
  if (isObject(template) && isObject(body)) {
    const out: Record<string, unknown> = { ...template }
    for (const [k, sent] of Object.entries(body)) {
      if (!(k in out)) continue
      out[k] = fromBody(out[k], sent)
    }
    return out
  }
  if (Array.isArray(template) && Array.isArray(body)) {
    if (body.length === 0) return template
    // a list the request sent comes back as a list of the same length, shaped like the response's item
    if (body.every(scalar) && template.every(scalar)) return body
    const proto = template[0]
    if (isObject(proto) && body.every(isObject)) return body.map((item) => fromBody(proto, item))
    return template
  }
  if (scalar(body) && scalar(template) && typeof body === typeof template) return body
  // a number typed into a text field still answers as the number the response declares
  if (
    typeof template === 'number' &&
    typeof body === 'string' &&
    body.trim() !== '' &&
    !Number.isNaN(Number(body))
  )
    return Number(body)
  return template
}

/** `petId` in `/pet/{petId}` is the `id` of the object that comes back. */
function fromPath(template: Record<string, unknown>, path: Record<string, unknown>) {
  const out = { ...template }
  const entries = Object.entries(path).filter(([, v]) => v !== undefined && v !== '')
  for (const [name, value] of entries) {
    if (name in out && !isObject(out[name]) && !Array.isArray(out[name])) {
      out[name] = coerce(value, out[name])
    } else if (
      entries.length === 1 &&
      'id' in out &&
      /^(id|.*[a-z]Id|.*_id)$/.test(name) &&
      !isObject(out.id) &&
      !Array.isArray(out.id)
    ) {
      out.id = coerce(value, out.id)
    }
  }
  return out
}

const scalarLeaf = (v: unknown): v is string | number | boolean => scalar(v)

/** Keys too generic to carry a value to a different place in the response. */
const GENERIC = new Set([
  'id',
  'object',
  'type',
  'kind',
  'created',
  'updated',
  'url',
  'livemode',
  'metadata',
  'status',
])

interface Leaf {
  path: (string | number)[]
  value: string | number | boolean
}

/** Scalar leaves of a request body, following objects and the first element of a list. */
function leavesOf(v: unknown, path: (string | number)[] = [], out: Leaf[] = [], depth = 0): Leaf[] {
  if (depth > 6) return out
  if (isObject(v)) for (const [k, x] of Object.entries(v)) leavesOf(x, [...path, k], out, depth + 1)
  else if (Array.isArray(v)) {
    if (v.length) leavesOf(v[0], [...path, 0], out, depth + 1)
  } else if (scalarLeaf(v)) out.push({ path, value: v })
  return out
}

const at = (v: unknown, path: (string | number)[]): unknown => {
  let cur: unknown = v
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string | number, unknown>)[p]
  }
  return cur
}

/** Every place `key` holds a plain value in the response (objects and the first item of lists). */
function placesOf(
  v: unknown,
  key: string,
  path: (string | number)[] = [],
  out: (string | number)[][] = [],
  depth = 0,
): (string | number)[][] {
  if (depth > 5) return out
  if (isObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === key && scalarLeaf(x)) out.push([...path, k])
      else placesOf(x, key, [...path, k], out, depth + 1)
    }
  } else if (Array.isArray(v) && v.length) placesOf(v[0], key, [...path, 0], out, depth + 1)
  return out
}

const sameKind = (sent: unknown, like: unknown) =>
  typeof sent === typeof like ||
  (typeof like === 'number' &&
    typeof sent === 'string' &&
    sent.trim() !== '' &&
    !Number.isNaN(Number(sent)))

function setAt(root: unknown, path: (string | number)[], value: unknown) {
  const parent = at(root, path.slice(0, -1))
  if (parent !== null && typeof parent === 'object')
    (parent as Record<string | number, unknown>)[path[path.length - 1] as string | number] = value
}

/**
 * A field the request sent that the response does not have at the same place, but has once somewhere
 * else (`budget_amount` in the request, `budget.budget_amount` in the response): when there is exactly one
 * such place, and the value fits it, the sent value goes there. Generic keys are never moved.
 */
function fromBodyElsewhere(template: unknown, sent: unknown, body: unknown): unknown {
  const out = structuredClone(template)
  const used = new Set(leavesOf(body).map((l) => l.path.join('\u0000')))
  for (const leaf of leavesOf(sent)) {
    if (at(out, leaf.path) !== undefined) continue
    const key = String(leaf.path[leaf.path.length - 1])
    if (GENERIC.has(key) || typeof leaf.path[leaf.path.length - 1] === 'number') continue
    const places = placesOf(out, key).filter((p) => !used.has(p.join('\u0000')))
    if (places.length !== 1) continue
    const place = places[0] as (string | number)[]
    const current = at(out, place)
    if (!sameKind(leaf.value, current)) continue
    setAt(out, place, coerce(leaf.value, current))
    used.add(place.join('\u0000'))
  }
  return out
}

/** `limit` and friends: how many items a list answer holds. */
const PAGE_SIZE = /^(limit|per_?page|page_?size|size|count|max|max_?results|take)$/i

function firstOf(v: unknown): unknown {
  if (Array.isArray(v)) return v[0]
  if (typeof v === 'string' && v.includes(',')) return v.split(',')[0]?.trim()
  return v
}

/** A filter in the query becomes the value of that field on what comes back, and a page size its length. */
function fromQuery(template: unknown, query: Record<string, unknown>): unknown {
  const entries = Object.entries(query)
    .map(([k, v]) => [k, firstOf(v)] as const)
    .filter(([, v]) => scalarLeaf(v) && v !== '')
  if (entries.length === 0) return template

  const stamp = (item: Record<string, unknown>) => {
    const out = { ...item }
    for (const [k, v] of entries)
      if (k in out && scalarLeaf(out[k]) && sameKind(v, out[k])) out[k] = coerce(v, out[k])
    return out
  }
  const size = entries.find(([k]) => PAGE_SIZE.test(k))?.[1]
  const count =
    size !== undefined && Number.isFinite(Number(size))
      ? Math.min(Math.max(Math.trunc(Number(size)), 1), 10)
      : undefined
  const list = (items: unknown[]): unknown[] => {
    if (!items.every(isObject)) return items
    const base = items.map((i) => stamp(i as Record<string, unknown>))
    if (count === undefined || base.length === 0 || base.length >= count)
      return base.slice(0, count ?? base.length)
    const proto = base[0] as Record<string, unknown>
    return Array.from({ length: count }, (_, i) =>
      i < base.length
        ? base[i]
        : { ...proto, ...(typeof proto.id === 'number' ? { id: proto.id + i } : {}) },
    )
  }

  if (Array.isArray(template)) return list(template)
  if (isObject(template)) {
    const out: Record<string, unknown> = { ...template }
    // a wrapper such as { data: [...] } or { items: [...] }: the one list in it is the answer
    const lists = Object.entries(out).filter(
      ([, v]) => Array.isArray(v) && v.length > 0 && v.every(isObject),
    )
    if (lists.length === 1) out[lists[0]?.[0] as string] = list(lists[0]?.[1] as unknown[])
    else return stamp(out)
    return out
  }
  return template
}

/**
 * Makes a generated mock response agree with the request that produced it, like a small fake backend:
 * fields the response shares with the request body take the sent values, a field sent once and found
 * once elsewhere in the response goes there, the single path parameter becomes `id`, and query filters
 * and page sizes shape a list. Only keys the response already has are touched, so the example's shape
 * never changes.
 */
export function reflectRequest(
  template: unknown,
  req: { body?: unknown; path?: Record<string, unknown>; query?: Record<string, unknown> },
): unknown {
  let out = template
  if (req.body !== undefined) {
    // a list posted, one thing back: the first item is what the answer is about
    const sent =
      isObject(out) && Array.isArray(req.body) && req.body.length > 0 && req.body.every(isObject)
        ? req.body[0]
        : req.body
    if ((isObject(out) && isObject(sent)) || (Array.isArray(out) && Array.isArray(sent))) {
      out = fromBody(out, sent)
      if (isObject(out) && isObject(sent)) out = fromBodyElsewhere(out, sent, sent)
    }
  }
  if (isObject(out) && req.path) out = fromPath(out, req.path)
  if (req.query) out = fromQuery(out, req.query)
  return out
}
