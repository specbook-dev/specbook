/**
 * The messages a page and the browser extension exchange, and the extension's side of a fetch built
 * on the same `forward` as the dev server and the Worker, so one policy and one substitution apply
 * everywhere. No `chrome.*` here: the extension's worker wires `handleWireFetch` to its message port.
 */
import { forward, type ProxyDeps, type ProxyEvent } from './forward'
import type { ProxyPolicy } from './policy'

export const WIRE_VERSION = 1

export type WireBody = { kind: 'text'; text: string } | { kind: 'b64'; b64: string }

export interface WireRequest {
  method: string
  /** Absolute URL, query included. */
  url: string
  headers: Record<string, string>
  body?: WireBody
}

export interface WireResponse {
  status: number
  headers: Record<string, string>
  body?: WireBody
}

export type WireErrorCode =
  | 'not-allowed'
  | 'blocked'
  | 'timeout'
  | 'too-large'
  | 'network'
  | 'missing-secrets'
  | 'rate-limited'

/** Page to extension. */
export type WireCall =
  | { v: 1; type: 'ping' }
  | { v: 1; type: 'status'; apiOrigins: string[] }
  | { v: 1; type: 'fetch'; id: string; req: WireRequest }
  | { v: 1; type: 'abort'; id: string }

/** Extension to page. */
export type WireReply =
  | { v: 1; type: 'pong'; version: number }
  | { v: 1; type: 'status'; granted: string[]; missing: string[] }
  | { v: 1; type: 'response'; id: string; res: WireResponse }
  | { v: 1; type: 'error'; id: string; code: WireErrorCode; message: string }

const utf8 = new TextDecoder('utf-8', { fatal: true })
const utf8Encoder = new TextEncoder()

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** Text when the bytes are valid UTF-8 (readable in logs), base64 otherwise. */
export function encodeWireBody(bytes: Uint8Array): WireBody {
  try {
    return { kind: 'text', text: utf8.decode(bytes) }
  } catch {
    return { kind: 'b64', b64: toBase64(bytes) }
  }
}

export function decodeWireBody(body: WireBody): Uint8Array {
  return body.kind === 'text' ? utf8Encoder.encode(body.text) : fromBase64(body.b64)
}

/** A `Request` becomes a message. The body is read as bytes, so a file or a multipart boundary survives. */
export async function requestToWire(req: Request): Promise<WireRequest> {
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    headers[k] = v
  })
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== null
  return {
    method: req.method,
    url: req.url,
    headers,
    ...(hasBody ? { body: encodeWireBody(new Uint8Array(await req.arrayBuffer())) } : {}),
  }
}

export function wireToRequest(w: WireRequest): Request {
  return new Request(w.url, {
    method: w.method,
    headers: w.headers,
    body:
      w.body && w.method !== 'GET' && w.method !== 'HEAD'
        ? (decodeWireBody(w.body) as BodyInit)
        : undefined,
  })
}

export async function responseToWire(res: Response): Promise<WireResponse> {
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    headers[k] = v
  })
  const bytes = new Uint8Array(await res.arrayBuffer())
  return {
    status: res.status,
    headers,
    ...(bytes.length ? { body: encodeWireBody(bytes) } : {}),
  }
}

export function wireToResponse(w: WireResponse): Response {
  const noBody = w.status === 204 || w.status === 205 || w.status === 304
  return new Response(w.body && !noBody ? (decodeWireBody(w.body) as BodyInit) : null, {
    status: w.status,
    headers: w.headers,
  })
}

export interface WireFetchDeps {
  /** Whether the user has granted this API origin (the browser's own permission, or a list). */
  allow(origin: string): boolean | Promise<boolean>
  lookup?: ProxyDeps['lookup']
  fetch?: typeof fetch
  onEvent?: (e: ProxyEvent) => void
  /** Private and local addresses: allowed by default here, since the user granted them. */
  policy?: Pick<ProxyPolicy, 'allowPrivateHosts' | 'maxBodyBytes' | 'timeoutMs' | 'methods'>
}

/**
 * The extension's handling of one `fetch` message: the user's grant first, then the shared `forward`
 * (secret substitution, limits, the outbound call). The reply is always a message, never a throw.
 */
export async function handleWireFetch(
  msg: Extract<WireCall, { type: 'fetch' }>,
  deps: WireFetchDeps,
): Promise<WireReply> {
  const fail = (code: WireErrorCode, message: string): WireReply => ({
    v: 1,
    type: 'error',
    id: msg.id,
    code,
    message,
  })
  let origin: string
  try {
    origin = new URL(msg.req.url).origin
  } catch {
    return fail('blocked', 'the request has no valid URL')
  }
  if (!(await deps.allow(origin)))
    return fail('not-allowed', `${origin} has not been allowed for this site`)
  const res = await forward(
    wireToRequest(msg.req),
    { url: msg.req.url },
    {
      // there is no page here to be "cross-site": the check is the user's grant above
      policy: { allowPrivateHosts: true, ...deps.policy, refuseCrossSite: false },
      lookup: deps.lookup,
      fetch: deps.fetch,
      onEvent: deps.onEvent,
    },
  )
  if (res.status === 400 && res.headers.get('content-type')?.includes('json')) {
    const text = await res.clone().text()
    const m = /Missing secrets: ([^"]+)/.exec(text)
    if (m) return fail('missing-secrets', `Missing secrets: ${m[1]}`)
  }
  if (res.status === 504) return fail('timeout', 'the API timed out')
  if (res.status === 413) return fail('too-large', 'the request body is too large')
  if (res.status === 502) return fail('network', 'the API could not be reached')
  if (res.status === 403) return fail('blocked', (await res.text()).slice(0, 200))
  return { v: 1, type: 'response', id: msg.id, res: await responseToWire(res) }
}
