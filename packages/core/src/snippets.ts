// Copy-paste code samples for a request: cURL and Node fetch. Pure string building, no I/O.
// `{{secrets.NAME}}` becomes `$NAME` (cURL) or `process.env.NAME` (fetch), so samples never carry real secrets.

import { type FormStyle, flattenForm, isBlob } from './runner/encode'
import type { Encoding } from './types'

export type SnippetLang = 'curl' | 'fetch'

export interface SnippetInput {
  method: string
  /** absolute URL without the query string */
  url: string
  query?: Record<string, string | string[]>
  headers?: Record<string, string>
  body?: unknown
  encoding?: Encoding
  formArrays?: FormStyle
}

// `{{secrets.NAME}}` -> NAME, `{{session.token}}` -> SESSION_TOKEN (a login's result the reader must supply)
const SECRET = /\{\{\s*(?:secrets\.([\w$-]+)|session\.([\w$.-]+))\s*\}\}/g
const hasSecret = (s: string) => new RegExp(SECRET.source).test(s)
const envName = (n: string) => n.replace(/[^A-Za-z0-9_]/g, '_')

/** Text and environment-variable references, in order. */
function segments(s: string): (string | { env: string })[] {
  const out: (string | { env: string })[] = []
  let at = 0
  for (const m of s.matchAll(SECRET)) {
    if (m.index > at) out.push(s.slice(at, m.index))
    out.push({ env: m[1] ? envName(m[1]) : `SESSION_${envName(m[2] as string)}`.toUpperCase() })
    at = m.index + m[0].length
  }
  if (at < s.length) out.push(s.slice(at))
  return out
}

const queryString = (q: Record<string, string | string[]> | undefined) => {
  const parts: string[] = []
  for (const [k, v] of Object.entries(q ?? {}))
    for (const x of Array.isArray(v) ? v : [v])
      parts.push(`${encodeURIComponent(k)}=${encodeSecretSafe(x)}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

/** Percent-encode a value but keep `{{secrets.X}}` readable so it can be swapped for a variable. */
function encodeSecretSafe(v: string): string {
  return segments(v)
    .map((p) => (typeof p === 'string' ? encodeURIComponent(p) : `{{secrets.${p.env}}}`))
    .join('')
}

/** A real file, or the `{ file, type, size }` stand-in a recorded request keeps instead of bytes. */
function isFile(v: unknown): v is { name?: string; type?: string } {
  if (isBlob(v)) return true
  const o = v as Record<string, unknown> | null
  return !!o && typeof o === 'object' && typeof o.file === 'string' && 'size' in o && 'type' in o
}
const fileName = (v: { name?: string; file?: string }) => v.name ?? v.file ?? 'file'

const single = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Single quotes, or double quotes when a secret has to expand. */
function sh(s: string): string {
  if (!hasSecret(s)) return single(s)
  const body = segments(s)
    .map((p) => (typeof p === 'string' ? p.replace(/[\\"`$]/g, (c) => `\\${c}`) : `\${${p.env}}`))
    .join('')
  return `"${body}"`
}

function curl(i: SnippetInput): string {
  const enc = i.encoding ?? 'json'
  const lines: string[] = [sh(`${i.url}${queryString(i.query)}`)]
  const method = i.method.toUpperCase()
  const headers = { ...(i.headers ?? {}) }
  const has = (n: string) => Object.keys(headers).some((h) => h.toLowerCase() === n)
  const body = i.body
  const data: string[] = []
  const send = body !== undefined && body !== '' && enc !== 'none'

  if (send) {
    if (enc === 'json' || enc === 'graphql') {
      const json = JSON.stringify(
        typeof body === 'string' && enc === 'graphql' ? { query: body } : body,
      )
      data.push(`-d ${sh(json)}`)
      if (!has('content-type')) headers['Content-Type'] = 'application/json'
    } else if (enc === 'form') {
      for (const [k, v] of flattenForm(body, i.formArrays))
        data.push(`--data-urlencode ${sh(`${k}=${v}`)}`)
    } else if (enc === 'multipart') {
      for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>))
        for (const x of Array.isArray(v) ? v : [v]) {
          if (x === null || x === undefined) continue
          if (isFile(x)) data.push(`-F ${sh(`${k}=@${fileName(x)}`)}`)
          else
            data.push(`-F ${sh(`${k}=${typeof x === 'object' ? JSON.stringify(x) : String(x)}`)}`)
        }
    } else if (enc === 'binary') {
      data.push(`--data-binary ${sh(`@${isFile(body) ? fileName(body) : 'file'}`)}`)
      if (!has('content-type'))
        headers['Content-Type'] = isFile(body) && body.type ? body.type : 'application/octet-stream'
    } else {
      data.push(`-d ${sh(String(body))}`)
      if (!has('content-type')) headers['Content-Type'] = 'text/plain'
    }
  }

  const defaultMethod = data.length ? 'POST' : 'GET'
  if (method !== defaultMethod) lines.push(`-X ${method}`)
  for (const [k, v] of Object.entries(headers)) lines.push(`-H ${sh(`${k}: ${v}`)}`)
  lines.push(...data)
  return `curl ${lines.join(' \\\n  ')}`
}

const IDENT = /^[A-Za-z_$][\w$]*$/

/** A JS string literal; a template literal when a secret has to be read from `process.env`. */
function js(s: string): string {
  if (!hasSecret(s))
    return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
  const body = segments(s)
    .map((p) =>
      typeof p === 'string'
        ? p.replace(/[\\`]|\$\{/g, (c) => `\\${c}`)
        : `\${process.env.${p.env}}`,
    )
    .join('')
  return `\`${body}\``
}

const key = (k: string) => (IDENT.test(k) ? k : js(k))

function lit(v: unknown, pad: string): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return js(v)
  if (typeof v !== 'object') return String(v)
  const inner = `${pad}  `
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return `[\n${v.map((x) => `${inner}${lit(x, inner)},`).join('\n')}\n${pad}]`
  }
  const entries = Object.entries(v)
  if (entries.length === 0) return '{}'
  return `{\n${entries.map(([k, x]) => `${inner}${key(k)}: ${lit(x, inner)},`).join('\n')}\n${pad}}`
}

function nodeFetch(i: SnippetInput): string {
  const enc = i.encoding ?? 'json'
  const method = i.method.toUpperCase()
  const headers = { ...(i.headers ?? {}) }
  const has = (n: string) => Object.keys(headers).some((h) => h.toLowerCase() === n)
  const body = i.body
  const send = body !== undefined && body !== '' && enc !== 'none'
  const pre: string[] = []
  let bodyExpr: string | undefined
  let needsFs = false

  if (send) {
    if (enc === 'json' || enc === 'graphql') {
      const value = typeof body === 'string' && enc === 'graphql' ? { query: body } : body
      bodyExpr = `JSON.stringify(${lit(value, '  ')})`
      if (!has('content-type')) headers['Content-Type'] = 'application/json'
    } else if (enc === 'form') {
      const pairs = flattenForm(body, i.formArrays)
      const unique = new Set(pairs.map(([k]) => k)).size === pairs.length
      bodyExpr = unique
        ? `new URLSearchParams(${lit(Object.fromEntries(pairs), '  ')})`
        : `new URLSearchParams(${lit(pairs, '  ')})`
      if (!has('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    } else if (enc === 'multipart') {
      pre.push('const form = new FormData()')
      for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>))
        for (const x of Array.isArray(v) ? v : [v]) {
          if (x === null || x === undefined) continue
          if (isFile(x)) {
            needsFs = true
            const name = fileName(x)
            pre.push(`form.append(${js(k)}, await openAsBlob(${js(name)}), ${js(name)})`)
          } else
            pre.push(
              `form.append(${js(k)}, ${js(typeof x === 'object' ? JSON.stringify(x) : String(x))})`,
            )
        }
      bodyExpr = 'form'
    } else if (enc === 'binary') {
      needsFs = true
      bodyExpr = `await openAsBlob(${js(isFile(body) ? fileName(body) : 'file')})`
      if (!has('content-type'))
        headers['Content-Type'] = isFile(body) && body.type ? body.type : 'application/octet-stream'
    } else {
      bodyExpr = js(String(body))
      if (!has('content-type')) headers['Content-Type'] = 'text/plain'
    }
  }

  const url = `${i.url}${queryString(i.query)}`
  const opts: string[] = []
  if (method !== 'GET') opts.push(`  method: ${js(method)},`)
  if (Object.keys(headers).length)
    opts.push(
      `  headers: {\n${Object.entries(headers)
        .map(([k, v]) => `    ${key(k)}: ${js(v)},`)
        .join('\n')}\n  },`,
    )
  if (bodyExpr) opts.push(`  body: ${bodyExpr},`)

  const head = needsFs ? ["import { openAsBlob } from 'node:fs'", ''] : []
  const call =
    opts.length === 0
      ? `const res = await fetch(${js(url)})`
      : `const res = await fetch(${js(url)}, {\n${opts.join('\n')}\n})`
  return [...head, ...pre, call, 'console.log(res.status, await res.text())'].join('\n')
}

export function toSnippet(lang: SnippetLang, input: SnippetInput): string {
  return lang === 'curl' ? curl(input) : nodeFetch(input)
}

export const snippetLangs: { id: SnippetLang; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'fetch', label: 'Node fetch' },
]
