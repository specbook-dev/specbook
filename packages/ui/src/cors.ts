// What a page can know about a cross-origin call before and after the browser blocks it. Shared by the transport that
// sends a request and the `fetch` a script is given, so both say the same thing and offer the same fix.

import { READ_METHODS } from '@specbook/core'

/** What a browser may send to an API without the person's say-so (as the extension's read-only default). */
export const READS = READ_METHODS
const SIMPLE_HEADERS = new Set(['accept', 'accept-language', 'content-language', 'content-type'])
const SIMPLE_TYPES = new Set([
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
])

/**
 * Whether a browser asks the API's permission (a CORS preflight) before sending this request. If it
 * does and the API does not answer yes, the request never leaves the page, so trying it directly cannot
 * reach an API that blocks browsers. Only a plain POST, with a form or text body (or none) and no
 * header of its own, goes out unasked.
 */
export function willPreflight(req: {
  method: string
  encoding: string
  headers: Record<string, string>
}) {
  const method = req.method.toUpperCase()
  if (READS.has(method)) return false
  if (method !== 'POST') return true
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  if (Object.keys(headers).some((k) => !SIMPLE_HEADERS.has(k))) return true
  const type = (
    headers['content-type'] ??
    (req.encoding === 'json' || req.encoding === 'graphql' ? 'application/json' : 'text/plain')
  )
    .split(';')[0]
    ?.trim()
    .toLowerCase()
  return !SIMPLE_TYPES.has(type ?? '')
}

/**
 * What the page can offer for a call the browser blocked, said where the failure is shown: send it through the extension,
 * or update the extension. Nothing for the page's own origin (that is no CORS) or for an unknown one.
 */
export function corsHint(
  origin: string | undefined,
  pageOrigin: string | undefined,
  level: 'ready' | 'outdated' | undefined,
): { code: 'cors' | 'outdated'; origin: string } | undefined {
  return origin && origin !== pageOrigin
    ? { code: level === 'outdated' ? 'outdated' : 'cors', origin }
    : undefined
}
