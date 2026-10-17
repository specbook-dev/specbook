// Running a list of requests and flows the way `specbook test` does: in order, retrying a failure, stopping at a number of
// failures or at a global deadline. The CLI and the docs site's terminal share it, so what the page shows is what a
// terminal does. Nothing here touches files or the process.

import type { Colors } from '../reporters/color'
import type { Sequence } from '../sequence'
import type { RequestDef, RunResult } from '../types'
import { type RunOptions, runRequest, runSequence } from './run'

export interface SuiteTarget {
  title: string
  /** project file, shown in reports */
  file?: string
  tags: string[]
  run: RequestDef<any, any, any> | Sequence<any, any>
}

export interface SuiteOptions {
  /** what every run is given; `signal` is the suite's own */
  run: Omit<RunOptions, 'signal'>
  /** extra tries for a failing target (0 = one try) */
  retries?: number
  /** stop after this many failed targets */
  bail?: number
  /** milliseconds after which no further target starts, and a running one is aborted */
  globalTimeoutMs?: number
  /** called before each try, e.g. to seed faker again */
  beforeAttempt?: () => void
  /** called when a failing target is about to be tried again */
  onRetry?: (target: SuiteTarget, attempt: number, allowed: number) => void
}

export interface SuiteResult {
  results: RunResult[]
  failures: number
  /** targets that did not start */
  notRun: number
  /** why the suite stopped early; empty when it did not */
  stopped: string
}

export async function runSuite(targets: SuiteTarget[], o: SuiteOptions): Promise<SuiteResult> {
  const controller = new AbortController()
  const deadline = o.globalTimeoutMs
    ? setTimeout(() => controller.abort(), o.globalTimeoutMs)
    : undefined
  const results: RunResult[] = []
  const allowed = 1 + Math.max(0, o.retries ?? 0)
  let failures = 0
  let notRun = 0
  let stopped = ''
  for (const [i, t] of targets.entries()) {
    if (controller.signal.aborted) {
      notRun = targets.length - i
      stopped = `stopped: the global timeout of ${o.globalTimeoutMs}ms passed`
      break
    }
    let result: RunResult | undefined
    let attempt = 0
    while (attempt < allowed) {
      attempt++
      o.beforeAttempt?.()
      const opts = { ...o.run, signal: controller.signal }
      result =
        t.run.kind === 'sequence' ? await runSequence(t.run, opts) : await runRequest(t.run, opts)
      if (result.status === 'pass' || controller.signal.aborted) break
      if (attempt < allowed) o.onRetry?.(t, attempt + 1, allowed)
    }
    const final = result as RunResult
    results.push({
      ...final,
      file: t.file,
      attempts: attempt,
      flaky: final.status === 'pass' && attempt > 1,
      tags: final.tags.length ? final.tags : t.tags,
    })
    if (final.status !== 'pass') failures++
    if (o.bail && failures >= o.bail && i < targets.length - 1) {
      notRun = targets.length - i - 1
      stopped = `stopped after ${failures} failed ${failures === 1 ? 'flow' : 'flows'} (--bail)`
      break
    }
  }
  if (deadline) clearTimeout(deadline)
  return { results, failures, notRun, stopped }
}

/** The line a run opens with: the tool and version, then what is being run and where. */
export function headerLine(
  h: {
    version: string
    env: string
    picked: number
    total: number
    /** `main@abc1234`, `bundle <sha> built <date>` */
    where?: string[]
  },
  colors: Colors,
): string {
  return `${colors.bold(`specbook test ${h.version}`)}  ${colors.dim(
    [
      `env ${h.env}`,
      `${h.picked}${h.picked < h.total ? `/${h.total}` : ''} tests`,
      ...(h.where ?? []),
    ].join('  ·  '),
  )}\n\n`
}

/** What a retry looks like in a terminal. */
export const retryLine = (colors: Colors, title: string, attempt: number, allowed: number) =>
  `  ${colors.yellow('↻')} retrying ${title} (attempt ${attempt} of ${allowed})\n`
