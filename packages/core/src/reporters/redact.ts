// What a report may show of a run. Resolved secret values are already masked by the runner; this removes what is secret
// without being one of ours: credentials in headers, and tokens and passwords that an API returns or a request captures.

import type { AssertionResult, RunResult, StepResult } from '../types'

export const REDACTED = '***'

/** Headers whose values are never shown, whatever they hold. */
const DENIED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
])

export const isDeniedHeader = (name: string) => DENIED_HEADERS.has(name.toLowerCase())

/** `accessToken`, `access_token`, `client-secret` → words joined by `_`, lowercase. */
const normalize = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-.\s]+/g, '_')
    .toLowerCase()

const SENSITIVE =
  /(^|_)(tokens?|secrets?|passwords?|passwd|authorization|credentials?|cookies?|api_?keys?|private_?keys?|access_?keys?|secret_?keys?)$/

/** Whether a property named like this holds something that should not be printed (`access_token`, `password`, `apiKey`). */
export const isSensitiveKey = (key: string) => SENSITIVE.test(normalize(key))

function redactValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactValue)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        isSensitiveKey(k) && (typeof x === 'string' || typeof x === 'number')
          ? REDACTED
          : redactValue(x),
      ]),
    )
  }
  return v
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, isDeniedHeader(k) ? REDACTED : v]),
  )
}

function redactAssertion(a: AssertionResult): AssertionResult {
  const hasValues = 'actual' in a || 'expected' in a
  return {
    ...a,
    actual: redactValue(a.actual),
    expected: redactValue(a.expected),
    // a recorded diff is text made from the values; with the values present it is rebuilt from the clean ones
    diff: hasValues ? undefined : a.diff,
  }
}

function redactStep(s: StepResult): StepResult {
  return {
    ...s,
    assertions: s.assertions.map(redactAssertion),
    request: s.request
      ? {
          ...s.request,
          headers: redactHeaders(s.request.headers),
          body: redactValue(s.request.body),
        }
      : undefined,
    response: s.response
      ? {
          ...s.response,
          headers: redactHeaders(s.response.headers),
          body: redactValue(s.response.body),
        }
      : undefined,
    captured: redactValue(s.captured) as Record<string, unknown>,
    children: s.children?.map(redactStep),
  }
}

/** A copy of the results that is safe to print, attach to a build or send to a monitoring service. */
export function redactResults(results: RunResult[]): RunResult[] {
  return results.map((r) => ({ ...r, steps: r.steps.map(redactStep) }))
}
