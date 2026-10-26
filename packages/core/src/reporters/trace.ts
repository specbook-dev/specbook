// The request and response of a step as text, for a failure: what was sent, what came back, redacted and shortened.
// For a script step: what it was given, what it said and what it returned.

import { statusText } from '../diff'
import type { StepResult } from '../types'
import { isDeniedHeader, REDACTED } from './redact'

/** Response headers worth showing: the rest is noise in a failure. */
const SHOWN_RESPONSE_HEADERS = [
  'content-type',
  'x-request-id',
  'x-correlation-id',
  'x-amzn-trace-id',
  'traceparent',
  'retry-after',
  'location',
]

export interface TraceOptions {
  /** service → the address its calls go to (`https://api.example.com/v1`: origin and base path), to show the full URL */
  origins?: Record<string, string>
  /** characters of a body shown before it is cut (default 2048) */
  maxBody?: number
}

function body(v: unknown, max: number): string[] {
  if (v === undefined || v === null || v === '') return []
  let text: string
  try {
    text = typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? String(v))
  } catch {
    text = String(v)
  }
  const cut = text.length > max
  const lines = (cut ? text.slice(0, max) : text).split('\n')
  if (cut) lines.push(`… ${text.length - max} more characters`)
  return lines
}

const query = (q: Record<string, string | string[]>) => {
  const parts = Object.entries(q).flatMap(([k, v]) =>
    (Array.isArray(v) ? v : [v]).map((x) => `${k}=${x}`),
  )
  return parts.length ? `?${parts.join('&')}` : ''
}

/** The trace of one step as lines (without indentation): `Request`, its headers and body, `Response`, and the same. A script has `Script`. */
export function traceLines(step: StepResult, o: TraceOptions = {}): string[] {
  const max = o.maxBody ?? 2048
  const out: string[] = []
  const r = step.request
  if (r) {
    const origin = o.origins?.[r.service] ?? ''
    out.push(`Request   ${r.method} ${origin}${r.url}${query(r.query)}`)
    for (const [k, v] of Object.entries(r.headers))
      out.push(`  ${k}: ${isDeniedHeader(k) ? REDACTED : v}`)
    for (const l of body(r.body, max)) out.push(`  ${l}`)
  }
  const res = step.response
  if (res) {
    out.push(
      `Response  ${[res.status, statusText(res.status)].filter(Boolean).join(' ')}  ${res.durationMs}ms`,
    )
    for (const name of SHOWN_RESPONSE_HEADERS) {
      const v = res.headers[name]
      if (v !== undefined) out.push(`  ${name}: ${isDeniedHeader(name) ? REDACTED : v}`)
    }
    for (const l of body(res.body, max)) out.push(`  ${l}`)
  }
  const sc = step.script
  if (sc) {
    out.push(`Script    ${sc.id} (${sc.runtime})`)
    const part = (title: string, lines: string[]) => {
      if (lines.length) out.push(`  ${title}`, ...lines.map((l) => `    ${l}`))
    }
    part('Inputs', Object.keys(sc.inputs).length ? body(sc.inputs, max) : [])
    part('Logs', sc.logs ?? [])
    part('Output', body(sc.output, max))
  }
  return out
}
