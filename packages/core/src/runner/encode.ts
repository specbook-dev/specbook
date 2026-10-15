import type { Encoding } from '../types'

/** How an array field is written: `a[0]=`, `a[]=`, repeated `a=`, or one joined value (spec `style`). */
export type FormArrays = 'indices' | 'brackets' | 'repeat' | 'comma' | 'space' | 'pipe'
/** One style for every field, or per top-level field (from the spec's `encoding.<field>`). */
export type FormStyle = FormArrays | Record<string, FormArrays>

const JOIN = { comma: ',', space: ' ', pipe: '|' } as const

export interface Encoded {
  body?: BodyInit
  contentType?: string
}

export const isBlob = (v: unknown): v is Blob => typeof Blob !== 'undefined' && v instanceof Blob

/** Flatten nested values to `[bracket[key], value]` pairs. */
export function flattenForm(
  body: unknown,
  arrays: FormStyle = 'indices',
  prefix = '',
  out: [string, string][] = [],
): [string, string][] {
  if (typeof arrays === 'string' || prefix || body === null || typeof body !== 'object')
    flatten(prefix, body, out, typeof arrays === 'string' ? arrays : 'indices')
  else
    for (const [k, v] of Object.entries(body))
      flatten(k, v, out, (arrays as Record<string, FormArrays>)[k] ?? 'indices')
  return out
}

function flatten(prefix: string, v: unknown, out: [string, string][], arrays: FormArrays) {
  if (v === null || v === undefined) return
  if (Array.isArray(v) && arrays in JOIN && v.every((x) => x === null || typeof x !== 'object')) {
    out.push([prefix, v.map(String).join(JOIN[arrays as keyof typeof JOIN])])
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => {
      const key =
        arrays === 'indices' || arrays in JOIN
          ? `${prefix}[${i}]`
          : arrays === 'brackets'
            ? `${prefix}[]`
            : prefix
      flatten(key, x, out, arrays)
    })
  } else if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) flatten(prefix ? `${prefix}[${k}]` : k, x, out, arrays)
  } else out.push([prefix, String(v)])
}

/** Stripe-style bracket encoding for application/x-www-form-urlencoded. */
export function encodeForm(body: unknown, arrays: FormStyle = 'indices'): string {
  return flattenForm(body, arrays)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

function encodeMultipart(body: unknown): FormData {
  const fd = new FormData()
  const part = (key: string, v: unknown) => {
    if (v === null || v === undefined) return
    if (isBlob(v)) fd.append(key, v, (v as Blob & { name?: string }).name ?? 'file')
    else if (typeof v === 'object')
      fd.append(key, new Blob([JSON.stringify(v)], { type: 'application/json' }))
    else fd.append(key, String(v))
  }
  for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>)) {
    if (Array.isArray(v)) for (const x of v) part(k, x)
    else part(k, v)
  }
  return fd
}

/** GraphQL bodies are `{ query, variables?, operationName? }`; a bare string is the query. */
function encodeGraphql(body: unknown): string {
  return JSON.stringify(typeof body === 'string' ? { query: body } : body)
}

/**
 * Turn a rendered body into something fetch can send. `multipart` leaves the content type unset so that
 * fetch adds the boundary.
 */
export function encodeBody(
  encoding: Encoding,
  body: unknown,
  formArrays?: FormStyle,
  mediaType?: string,
): Encoded {
  switch (encoding) {
    case 'json':
      return { body: JSON.stringify(body), contentType: 'application/json' }
    case 'graphql':
      return { body: encodeGraphql(body), contentType: 'application/json' }
    case 'form':
      return {
        body: encodeForm(body, formArrays),
        contentType: 'application/x-www-form-urlencoded',
      }
    case 'text':
      return { body: String(body), contentType: 'text/plain' }
    case 'multipart':
      return { body: encodeMultipart(body) }
    case 'binary':
      return {
        body: body as BodyInit,
        // the spec's declared type wins: a server that says application/octet-stream rejects the
        // file's own image/png with 415
        contentType:
          mediaType || (isBlob(body) && body.type ? body.type : 'application/octet-stream'),
      }
    default:
      return { body: body as BodyInit }
  }
}

/** Replace file contents with `{ file, type, size }` so logs, reports and history never hold bytes. */
export function describeFiles<T>(value: T): T {
  if (isBlob(value)) {
    const f = value as Blob & { name?: string }
    return { file: f.name ?? 'file', type: f.type, size: f.size } as T
  }
  if (Array.isArray(value)) return value.map(describeFiles) as T
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, describeFiles(v)])) as T
  return value
}
