// The JSON report: the results with what a monitoring system needs to know about the run around them.

import type { RunResult } from '../types'
import type { CiInfo } from './ci'

export interface ReportMeta {
  env: string
  /** version of the specbook that ran it */
  specbook?: string
  node?: string
  os?: string
  git?: { sha?: string; branch?: string }
  ci?: CiInfo
  /** `bundle.json` details when run from a bundle */
  bundle?: { sha?: string; createdAt?: string }
  /** service → origin of the address its calls went to */
  services?: Record<string, string>
  startedAt: string
  finishedAt: string
}

export interface ReportTotals {
  flows: { passed: number; failed: number; errored: number; flaky: number }
  steps: { passed: number; failed: number; skipped: number }
  assertions: { passed: number; failed: number }
}

export interface RunReport extends ReportMeta {
  schemaVersion: 2
  durationMs: number
  totals: ReportTotals
  results: RunResult[]
}

export function reportTotals(results: RunResult[]): ReportTotals {
  const t: ReportTotals = {
    flows: { passed: 0, failed: 0, errored: 0, flaky: 0 },
    steps: { passed: 0, failed: 0, skipped: 0 },
    assertions: { passed: 0, failed: 0 },
  }
  for (const r of results) {
    if (r.status === 'pass') t.flows.passed++
    else if (r.status === 'error') t.flows.errored++
    else t.flows.failed++
    if (r.flaky) t.flows.flaky++
    t.steps.passed += r.totals.passed
    t.steps.failed += r.totals.failed
    t.steps.skipped += r.totals.skipped
    t.assertions.passed += r.totals.assertions.passed
    t.assertions.failed += r.totals.assertions.failed
  }
  return t
}

export function buildReport(results: RunResult[], meta: ReportMeta): RunReport {
  return {
    schemaVersion: 2,
    ...meta,
    durationMs: Math.max(0, Date.parse(meta.finishedAt) - Date.parse(meta.startedAt)),
    totals: reportTotals(results),
    results,
  }
}
