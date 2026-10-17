import type { Encoding, HttpMethod } from '../types'
import { encodeBody, type FormArrays } from './encode'

export interface PreparedRequest {
  service: string
  opId: string
  method: HttpMethod
  /** Path with path params substituted, starting with "/". */
  url: string
  query: Record<string, string | string[]>
  headers: Record<string, string>
  body?: unknown
  encoding: Encoding
  /** The Content-Type the spec declares for a binary body; wins over the file's own type. */
  mediaType?: string
  /** Array style per form field, from the spec's `encoding` object. */
  formArrays?: Record<string, FormArrays>
  timeoutMs?: number
  /** Mock status the caller wants served, e.g. the UI's "Respond with" (mock env only). */
  mockStatus?: number
  /** In-process hints for the mock transport; never serialized or substituted. */
  mock?: {
    hook?: import('../types').MockHook<any, any>
    vars: Record<string, unknown>
    pathParams: Record<string, unknown>
    rawQuery: Record<string, unknown>
    secured?: boolean
  }
}

export interface RawResponse {
  status: number
  headers: Record<string, string>
  text: string
  body: unknown
}

export type Transport = (req: PreparedRequest, signal?: AbortSignal) => Promise<RawResponse>

export function buildUrl(base: string, req: PreparedRequest): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(req.query)) {
    for (const x of Array.isArray(v) ? v : [v]) qs.append(k, x)
  }
  const q = qs.toString()
  return `${base.replace(/\/+$/, '')}${req.url}${q ? `?${q}` : ''}`
}

/** A config `baseUrl` may be relative (`/api/v1`): it is resolved against the page. */
export function absoluteBase(baseUrl: string, pageHref?: string): string {
  try {
    return new URL(baseUrl, pageHref).toString()
  } catch {
    return baseUrl
  }
}

/** How long a request waits for an answer when nothing says otherwise. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** What node's fetch says in `error.cause.code`, in words a person can act on. */
const WHY: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'host not found',
  ECONNRESET: 'connection reset',
  ETIMEDOUT: 'connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
}

/** node's bare "fetch failed" says nothing; its cause says why. A browser gives no cause, so its error is left as it is. */
function unreachable(e: unknown, url: string): unknown {
  const cause = (
    e as { cause?: { code?: string; message?: string; errors?: { code?: string }[] } } | undefined
  )?.cause
  if (!(e instanceof TypeError) || !cause) return e
  const code = cause.code ?? cause.errors?.find((x) => x.code)?.code
  const tls =
    code && /^CERT_|^ERR_TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code) ? 'certificate problem' : ''
  // a reason there are words for, else the cause's own message ("bad port"), else nothing to add
  const own = typeof cause.message === 'string' && cause.message.length <= 120 ? cause.message : ''
  const why = (code && WHY[code]) || tls || own
  if (!why) return e
  let host = url
  try {
    host = new URL(url).host
  } catch {
    /* an address that is not a URL is shown as it is */
  }
  return new Error(`Could not reach ${host}: ${why}.`, { cause: e })
}

export interface FetchTransportOptions {
  baseUrl: (service: string) => string
  fetch?: typeof fetch
}

export function createFetchTransport(opts: FetchTransportOptions): Transport {
  return async (req, signal) => {
    // a run stopped before this request left: nothing is sent, and no 'abort' will ever be heard from a signal that has fired
    if (signal?.aborted) throw new Error('Stopped before the API answered.')
    const f = opts.fetch ?? fetch
    const headers: Record<string, string> = { ...req.headers }
    let body: BodyInit | undefined
    if (req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
      const enc = encodeBody(req.encoding, req.body, req.formArrays, req.mediaType)
      body = enc.body
      if (enc.contentType) headers['content-type'] ??= enc.contentType
    }

    const ctl = new AbortController()
    let timedOut = false
    const timer = req.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          ctl.abort()
        }, req.timeoutMs)
      : undefined
    signal?.addEventListener('abort', () => ctl.abort())
    const url = buildUrl(opts.baseUrl(req.service), req)
    try {
      const res = await f(url, {
        method: req.method,
        headers,
        body,
        signal: ctl.signal,
      })
      const text = await res.text()
      const outHeaders: Record<string, string> = {}
      res.headers.forEach((v, k) => {
        outHeaders[k.toLowerCase()] = v
      })
      let parsed: unknown = text
      if (text.length === 0) parsed = undefined
      else {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
      }
      return { status: res.status, headers: outHeaders, text, body: parsed }
    } catch (e) {
      // an abort that the request's own timeout caused says so, not "This operation was aborted"
      if (timedOut) throw new Error(`Timed out after ${req.timeoutMs}ms: no answer from the API.`)
      // a person pressing Stop, or the run's own deadline: say so, not "This operation was aborted"
      if (signal?.aborted) throw new Error('Stopped before the API answered.')
      throw unreachable(e, url)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
