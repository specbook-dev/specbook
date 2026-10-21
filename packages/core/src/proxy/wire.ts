/**
 * The messages a page and the browser extension exchange, and the extension's side of a fetch built
 * on the same `forward` as the dev server and the Worker, so one policy and one substitution apply
 * everywhere. No `chrome.*` here: the extension's worker wires `handleWireFetch` to its message port.
 */
import { forward, type ProxyDeps, type ProxyEvent, REFUSAL_HEADER, type Refusal } from './forward'
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
  /** the API answered with a redirect, which is not followed */
  | 'redirect'
  /** this site may read the API but has not been allowed to modify data */
  | 'read-only'
  | 'aborted'

/** Page to extension. */
export type WireCall =
  /** `uiVersion`: the release of the page, so the extension can say when it is the one that is out of date */
  | { v: 1; type: 'ping'; uiVersion?: string }
  | { v: 1; type: 'status'; apiOrigins: string[] }
  /**
   * Ask for the missing origins to be allowed; the person decides in the extension's own window. With
   * `writes`, ask instead for changes (POST, PUT, PATCH, DELETE) to be allowed for origins that are
   * allowed to be read.
   */
  | { v: 1; type: 'grant'; apiOrigins: string[]; writes?: boolean }
  | { v: 1; type: 'fetch'; id: string; req: WireRequest }
  | { v: 1; type: 'abort'; id: string }

/** Extension to page. */
export type WireReply =
  | { v: 1; type: 'pong'; version: number }
  | { v: 1; type: 'status'; granted: string[]; missing: string[]; pageEnabled?: boolean }
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

export function wireToRequest(w: WireRequest, signal?: AbortSignal): Request {
  return new Request(w.url, {
    method: w.method,
    headers: w.headers,
    body:
      w.body && w.method !== 'GET' && w.method !== 'HEAD'
        ? (decodeWireBody(w.body) as BodyInit)
        : undefined,
    signal,
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
  /**
   * Private and local addresses are refused unless this says otherwise: a web page must not be able to
   * reach into the person's own network through an extension, and a grant to a public API is not a
   * grant to `localhost`. A caller passes `allowPrivateHosts: true` for a pair the person has opted in.
   */
  policy?: Pick<ProxyPolicy, 'allowPrivateHosts' | 'maxBodyBytes' | 'timeoutMs' | 'methods'>
}

/**
 * The extension's handling of one `fetch` message: the user's grant first, then the shared `forward`
 * (secret substitution, limits, the outbound call). The reply is always a message, never a throw.
 */
export async function handleWireFetch(
  msg: Extract<WireCall, { type: 'fetch' }>,
  deps: WireFetchDeps,
  signal?: AbortSignal,
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
    wireToRequest(msg.req, signal),
    { url: msg.req.url },
    {
      // there is no page here to be "cross-site": the check is the user's grant above
      policy: { allowPrivateHosts: false, ...deps.policy, refuseCrossSite: false },
      markRefusals: true,
      lookup: deps.lookup,
      fetch: deps.fetch,
      onEvent: deps.onEvent,
    },
  )
  // Only what `forward` itself refused becomes an error. The API's own 403, 413, 502 or 504 is an
  // answer, and the page needs to see it as one.
  const refused = res.headers.get(REFUSAL_HEADER) as Refusal | null
  if (refused) {
    let message = ''
    try {
      message = String(((await res.json()) as { error?: unknown }).error ?? '')
    } catch {
      /* no readable reason */
    }
    return fail(refused, message || refused)
  }
  return { v: 1, type: 'response', id: msg.id, res: await responseToWire(res) }
}

const isString = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.length <= max

function originOk(v: unknown): v is string {
  if (!isString(v)) return false
  try {
    const u = new URL(v)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === v
  } catch {
    return false
  }
}

/**
 * A `WireCall` from something that is not to be trusted (a web page's script, via a content script): every
 * field checked, and only known ones kept. `undefined` when it is not a well-formed call of this version.
 */
export function parseWireCall(input: unknown): WireCall | undefined {
  if (!input || typeof input !== 'object') return undefined
  const m = input as Record<string, unknown>
  if (m.v !== 1) return undefined
  switch (m.type) {
    case 'ping':
      if (m.uiVersion !== undefined && !isString(m.uiVersion, 64)) return undefined
      return {
        v: 1,
        type: 'ping',
        ...(m.uiVersion !== undefined ? { uiVersion: m.uiVersion } : {}),
      }
    case 'status':
    case 'grant': {
      const list = m.apiOrigins
      if (!Array.isArray(list) || list.length > 32 || !list.every(originOk)) return undefined
      const apiOrigins = [...new Set(list as string[])]
      if (m.type === 'grant' && m.writes === true)
        return { v: 1, type: 'grant', apiOrigins, writes: true }
      return { v: 1, type: m.type, apiOrigins }
    }
    case 'abort':
      return isString(m.id, 128) ? { v: 1, type: 'abort', id: m.id } : undefined
    case 'fetch': {
      const r = m.req as Record<string, unknown> | undefined
      if (!isString(m.id, 128) || !r || typeof r !== 'object') return undefined
      if (!isString(r.method, 16) || !/^[A-Za-z]+$/.test(r.method)) return undefined
      if (!isString(r.url, 8192)) return undefined
      try {
        const u = new URL(r.url)
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
      } catch {
        return undefined
      }
      const h = r.headers as Record<string, unknown> | undefined
      if (!h || typeof h !== 'object' || Array.isArray(h)) return undefined
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(h)) {
        if (!isString(k, 256) || !isString(v, 16_384)) return undefined
        headers[k] = v
      }
      let body: WireBody | undefined
      if (r.body !== undefined) {
        const b = r.body as Record<string, unknown>
        if (b && b.kind === 'text' && typeof b.text === 'string')
          body = { kind: 'text', text: b.text }
        else if (b && b.kind === 'b64' && typeof b.b64 === 'string')
          body = { kind: 'b64', b64: b.b64 }
        else return undefined
      }
      return {
        v: 1,
        type: 'fetch',
        id: m.id,
        req: { method: r.method.toUpperCase(), url: r.url, headers, ...(body ? { body } : {}) },
      }
    }
    default:
      return undefined
  }
}
