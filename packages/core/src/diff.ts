// A line diff for a failed assertion, shared by the command line and the UI so both show the same thing.

import type { AssertionResult } from './types'

export type DiffLine =
  | { kind: 'same' | 'expected' | 'received'; text: string }
  /** a run of unchanged lines left out */
  | { kind: 'skip'; text: string }

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

export const statusText = (status: number): string => STATUS_TEXT[status] ?? ''

/** A value as lines: strings as JSON (multi-line text as it is), everything else pretty-printed JSON. */
function show(v: unknown): string[] {
  if (typeof v === 'string') return v.includes('\n') ? v.split('\n') : [JSON.stringify(v)]
  if (v === undefined) return ['undefined']
  try {
    return (JSON.stringify(v, null, 2) ?? String(v)).split('\n')
  } catch {
    return [String(v)]
  }
}

/** Lines in common stay; the rest are `expected` (only in a) or `received` (only in b). */
function lineDiff(a: string[], b: string[]): DiffLine[] {
  const out: DiffLine[] = []
  // very large values are not worth a quadratic table: show one against the other
  if (a.length * b.length > 250_000) {
    for (const text of a) out.push({ kind: 'expected', text })
    for (const text of b) out.push({ kind: 'received', text })
    return out
  }
  const n = a.length
  const m = b.length
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (table[i] as Uint32Array)[j] =
        a[i] === b[j]
          ? ((table[i + 1] as Uint32Array)[j + 1] as number) + 1
          : Math.max(
              (table[i + 1] as Uint32Array)[j] as number,
              (table[i] as Uint32Array)[j + 1] as number,
            )
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] as string })
      i++
      j++
    } else if (
      ((table[i + 1] as Uint32Array)[j] as number) >= ((table[i] as Uint32Array)[j + 1] as number)
    ) {
      out.push({ kind: 'expected', text: a[i++] as string })
    } else {
      out.push({ kind: 'received', text: b[j++] as string })
    }
  }
  while (i < n) out.push({ kind: 'expected', text: a[i++] as string })
  while (j < m) out.push({ kind: 'received', text: b[j++] as string })
  return out
}

/** Keeps the changed lines and `context` lines around them; longer runs of unchanged lines become one `skip` line. */
function collapse(lines: DiffLine[], context: number): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, i) => {
    if (l.kind === 'same') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++)
      keep[k] = true
  })
  const out: DiffLine[] = []
  let skipped = 0
  const flush = () => {
    if (skipped > 0)
      out.push({ kind: 'skip', text: `… ${skipped} unchanged line${skipped > 1 ? 's' : ''}` })
    skipped = 0
  }
  lines.forEach((l, i) => {
    if (keep[i]) {
      flush()
      out.push(l)
    } else skipped++
  })
  flush()
  return out
}

/**
 * What a failed assertion expected and what it received, as diff lines: the status check reads as one pair of lines, values
 * are compared line by line, and an assertion that recorded only a diff string shows that.
 */
export function diffAssertion(a: AssertionResult, context = 3): DiffLine[] {
  if (a.operator === 'status') {
    const got =
      typeof a.actual === 'number' ? `${a.actual} ${statusText(a.actual)}`.trim() : String(a.actual)
    return [
      { kind: 'expected', text: `status ${a.expected}` },
      { kind: 'received', text: `status ${got}` },
    ]
  }
  if ('expected' in a || 'actual' in a)
    return collapse(lineDiff(show(a.expected), show(a.actual)), context)
  if (a.diff) return a.diff.split('\n').map((text) => ({ kind: 'same', text }))
  return []
}
