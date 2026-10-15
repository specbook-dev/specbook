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
  /** Mock status the caller wants served (mock env only). */
  mockStatus?: number
  /** In-process hints for the mock transport; never serialized or substituted. */
  mock?: {
    config?: import('../types').MockInput<any, any>
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

export interface FetchTransportOptions {
  baseUrl: (service: string) => string
  fetch?: typeof fetch
}

export function createFetchTransport(opts: FetchTransportOptions): Transport {
  return async (req, signal) => {
    const f = opts.fetch ?? fetch
    const headers: Record<string, string> = { ...req.headers }
    let body: BodyInit | undefined
    if (req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
      const enc = encodeBody(req.encoding, req.body, req.formArrays, req.mediaType)
      body = enc.body
      if (enc.contentType) headers['content-type'] ??= enc.contentType
    }
    if (req.mockStatus !== undefined) headers['x-specbook-mock-status'] = String(req.mockStatus)

    const ctl = new AbortController()
    const timer = req.timeoutMs ? setTimeout(() => ctl.abort(), req.timeoutMs) : undefined
    signal?.addEventListener('abort', () => ctl.abort())
    try {
      const res = await f(buildUrl(opts.baseUrl(req.service), req), {
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
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
