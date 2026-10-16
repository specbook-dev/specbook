import { signal } from '@preact/signals'
import type { RunResult } from '@specbook/core'

/** What a screen reader is told when a run finishes: the panel renders it in a polite live region. */
export const announcement = signal('')

/** One sentence for a finished run: a request by its response, a flow by how many steps passed. */
export function describeRun(r: RunResult): string {
  if (r.kind === 'request') {
    const s = r.steps.find((x) => x.response) ?? r.steps[0]
    if (!s?.response) return r.status === 'error' ? 'The request could not be sent.' : 'Done.'
    const checks = s.assertions.filter((a) => !a.pass).length
    return `${s.response.status}, ${r.durationMs} milliseconds${checks ? `, ${checks} check${checks === 1 ? '' : 's'} failed` : ''}.`
  }
  const word = r.status === 'pass' ? 'passed' : r.status === 'fail' ? 'failed' : 'could not run'
  return `Flow ${word}, ${r.totals.passed} of ${r.totals.steps} steps passed.`
}
