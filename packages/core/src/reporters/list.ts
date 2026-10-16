// The default report: steps as they finish, then what failed (with the assertion, a source frame and the trace) and a summary.

import { type DiffLine, diffAssertion } from '../diff'
import type { RunEvent } from '../runner/run'
import type { AssertionResult, RunResult, StepResult } from '../types'
import { type Colors, createColors } from './color'
import { reportTotals } from './envelope'
import { type TraceOptions, traceLines } from './trace'

export interface ListOptions {
  colors?: Colors
  /** only failures and the summary */
  quiet?: boolean
  /** show the request and response of a failed step (default), of every step, or not at all */
  trace?: 'on-failure' | 'always' | 'off'
  /** service → origin, to show full addresses in a trace */
  origins?: Record<string, string>
  /** paths are shown relative to this folder */
  cwd?: string
  /** the text of a project file, for the source frame of a failed assertion */
  readSource?: (file: string) => string | undefined
  /** the command that runs just this flow again */
  rerun?: (r: RunResult) => string | undefined
  /** how long the whole run took, for the summary */
  durationMs?: number
}

const MARKS = { pass: '✓', fail: '✗', error: '!', skipped: '–' } as const

export const formatDuration = (ms: number): string =>
  ms < 1000
    ? `${Math.round(ms)}ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(2)}s`
      : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`

const leaves = (steps: StepResult[]): StepResult[] =>
  steps.flatMap((s) => (s.children?.length ? leaves(s.children) : [s]))

function paint(status: StepResult['status'], c: Colors, text: string): string {
  return status === 'pass'
    ? c.green(text)
    : status === 'skipped'
      ? c.dim(text)
      : status === 'error'
        ? c.yellow(text)
        : c.red(text)
}

interface StepFacts {
  status: StepResult['status']
  flow: string
  step: string
  method?: string
  url?: string
  code?: number
  ms?: number
}

/** `✓ Checkout › Create order  POST /orders  201  85ms` */
export function stepLine(f: StepFacts, c: Colors, indent = '  '): string {
  const detail = [
    f.method && f.url ? `${f.method} ${f.url}` : '',
    f.code ? String(f.code) : '',
    f.ms !== undefined ? formatDuration(f.ms) : '',
  ]
    .filter(Boolean)
    .join('  ')
  return `${indent}${paint(f.status, c, MARKS[f.status])} ${f.flow} › ${f.step}${detail ? `  ${c.dim(detail)}` : ''}`
}

function diffText(lines: DiffLine[], c: Colors, indent: string): string[] {
  return lines.map((l) =>
    l.kind === 'expected'
      ? `${indent}${c.green(`- ${l.text}`)}`
      : l.kind === 'received'
        ? `${indent}${c.red(`+ ${l.text}`)}`
        : l.kind === 'skip'
          ? `${indent}${c.dim(`  ${l.text}`)}`
          : `${indent}${c.dim(`  ${l.text}`)}`,
  )
}

/** The lines around `line` with a caret under `column`, from a file's text. */
export function codeFrame(
  source: string,
  line: number,
  column = 1,
  c: Colors = createColors(false),
  around = 2,
): string[] {
  const lines = source.split('\n')
  const from = Math.max(1, line - around)
  const to = Math.min(lines.length, line + around)
  const width = String(to).length
  const out: string[] = []
  for (let n = from; n <= to; n++) {
    const text = lines[n - 1] ?? ''
    const mark = n === line ? c.red('>') : ' '
    out.push(`${mark} ${c.dim(String(n).padStart(width))} ${c.dim('|')} ${text}`)
    if (n === line)
      out.push(
        `  ${' '.repeat(width)} ${c.dim('|')} ${' '.repeat(Math.max(0, column - 1))}${c.red('^')}`,
      )
  }
  return out
}

const rel = (file: string, cwd?: string) =>
  cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file

function assertionBlock(a: AssertionResult, o: ListOptions, c: Colors): string[] {
  const out = [`    ${c.red('✗')} ${a.label}`]
  const diff = diffAssertion(a)
  if (diff.length) {
    out.push(`      ${c.green('- Expected')}  ${c.red('+ Received')}`)
    out.push(...diffText(diff, c, '      '))
  }
  if (a.location) {
    out.push(
      `      ${c.dim(`at ${rel(a.location.file, o.cwd)}:${a.location.line}:${a.location.column ?? 1}`)}`,
    )
    const text = o.readSource?.(a.location.file)
    if (text !== undefined)
      for (const l of codeFrame(text, a.location.line, a.location.column, c))
        out.push(`        ${l}`)
  }
  return out
}

/** One block per failed or errored step: the assertions that failed, why a step errored, and its trace. */
export function formatFailures(results: RunResult[], o: ListOptions = {}): string {
  const c = o.colors ?? createColors(false)
  const out: string[] = []
  for (const r of results) {
    for (const s of leaves(r.steps)) {
      if (s.status !== 'fail' && s.status !== 'error') continue
      const where = r.file ? `${r.file} › ` : ''
      out.push(
        '',
        `${c.bold(c.red(' FAIL '))} ${where}${r.title} › ${s.name}  ${c.dim(`[${r.env}] ${formatDuration(s.durationMs)}`)}`,
      )
      if (s.status === 'error') out.push(`    ${c.yellow('!')} ${s.error ?? 'error'}`)
      for (const a of s.assertions) if (!a.pass) out.push(...assertionBlock(a, o, c))
      if ((o.trace ?? 'on-failure') !== 'off')
        for (const l of traceLines(s, { origins: o.origins })) out.push(`    ${c.dim(l)}`)
      const rerun = o.rerun?.(r)
      if (rerun) out.push(`    ${c.dim(`Re-run: ${rerun}`)}`)
    }
  }
  return out.join('\n')
}

/** `Flows 8 passed | 1 failed | 1 flaky`, steps, assertions, time and the slowest steps. */
export function formatSummary(results: RunResult[], o: ListOptions = {}): string {
  const c = o.colors ?? createColors(false)
  const t = reportTotals(results)
  const part = (n: number, word: string, paintFn: (s: string) => string) =>
    n ? paintFn(`${n} ${word}`) : ''
  const join = (...parts: string[]) => parts.filter(Boolean).join(c.dim(' | ')) || c.dim('none')
  const lines = [
    '',
    `${c.bold(' Flows      ')} ${join(
      part(t.flows.failed, 'failed', c.red),
      part(t.flows.errored, 'errored', c.yellow),
      part(t.flows.flaky, 'flaky', c.yellow),
      part(t.flows.passed, 'passed', c.green),
    )} ${c.dim(`(${results.length})`)}`,
    `${c.bold(' Steps      ')} ${join(
      part(t.steps.failed, 'failed', c.red),
      part(t.steps.skipped, 'skipped', c.dim),
      part(t.steps.passed, 'passed', c.green),
    )}`,
    `${c.bold(' Assertions ')} ${join(
      part(t.assertions.failed, 'failed', c.red),
      part(t.assertions.passed, 'passed', c.green),
    )}`,
  ]
  const total = o.durationMs ?? results.reduce((n, r) => n + r.durationMs, 0)
  lines.push(`${c.bold(' Duration   ')} ${formatDuration(total)}`)
  const slow = results
    .flatMap((r) =>
      leaves(r.steps)
        .filter((s) => s.status !== 'skipped')
        .map((s) => ({ name: `${r.title} › ${s.name}`, ms: s.durationMs })),
    )
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)
  if (slow.length > 1) {
    lines.push(
      `${c.bold(' Slowest    ')} ${c.dim(slow.map((s) => `${s.name} ${formatDuration(s.ms)}`).join(' · '))}`,
    )
  }
  return lines.join('\n')
}

function stepFacts(r: RunResult, s: StepResult): StepFacts {
  return {
    status: s.status,
    flow: r.title,
    step: s.name,
    method: s.request?.method,
    url: s.request?.url,
    code: s.response?.status,
    ms: s.status === 'skipped' ? undefined : s.durationMs,
  }
}

/** The whole report at once, from finished results (what the streaming reporter prints, in one string). */
export function formatList(results: RunResult[], o: ListOptions = {}): string {
  const c = o.colors ?? createColors(false)
  const lines: string[] = []
  if (!o.quiet)
    for (const r of results)
      for (const s of leaves(r.steps)) lines.push(stepLine(stepFacts(r, s), c))
  const failures = formatFailures(results, o)
  return [lines.join('\n'), failures, formatSummary(results, o)].filter((x) => x !== '').join('\n')
}

/** Prints each step as it finishes, from the run's events; at the end prints the failures and the summary. */
export function createListReporter(o: ListOptions & { write(text: string): void }) {
  const c = o.colors ?? createColors(false)
  let flow = ''
  const facts = new Map<string, Partial<StepFacts>>()
  return {
    onEvent(e: RunEvent) {
      if (e.type === 'run:start') flow = e.title ?? e.id
      else if (e.type === 'request')
        facts.set(e.name, { ...facts.get(e.name), method: e.request.method, url: e.request.url })
      else if (e.type === 'response')
        facts.set(e.name, { ...facts.get(e.name), code: e.status, ms: e.durationMs })
      else if (e.type === 'step:end') {
        const f = facts.get(e.name)
        facts.delete(e.name)
        if (e.status === 'pass' && o.quiet) return
        o.write(`${stepLine({ ...f, status: e.status, flow, step: e.name }, c)}\n`)
      }
    },
    onEnd(results: RunResult[]) {
      const rest = [formatFailures(results, o), formatSummary(results, o)].filter((x) => x !== '')
      o.write(`${rest.join('\n')}\n`)
    },
  }
}

export type { TraceOptions }
