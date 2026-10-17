import { stripAnsi } from '../assert'
import { diffAssertion } from '../diff'
import type { RunResult, StepResult } from '../types'
import { reportTotals } from './envelope'
import { traceLines } from './trace'

export interface Reporter {
  onEvent?(e: unknown): void
  onEnd(results: RunResult[]): void | Promise<void>
}

const mark = { pass: '✓', fail: '✗', error: '!', skipped: '–' } as const

function stepLines(s: StepResult, indent: string, out: string[]) {
  out.push(
    `${indent}${mark[s.status]} ${s.name}${s.response ? ` (${s.response.status}, ${s.durationMs}ms)` : ''}`,
  )
  if (s.error) out.push(`${indent}    ${s.error}`)
  for (const u of s.uses ?? [])
    if (u.shadows)
      out.push(
        `${indent}    ⚠ ${u.key}: ${u.step ?? 'a capture'} (${u.shadows.replacedBy}) replaced ${u.shadows.source} (${u.shadows.type})`,
      )
  for (const a of s.assertions) {
    out.push(`${indent}    ${a.pass ? '✓' : '✗'} ${a.label}`)
    if (!a.pass && a.diff) for (const l of a.diff.split('\n')) out.push(`${indent}        ${l}`)
  }
  for (const c of s.children ?? []) stepLines(c, `${indent}  `, out)
}

export function formatPretty(results: RunResult[]): string {
  const out: string[] = []
  for (const r of results) {
    out.push(`${mark[r.status]} ${r.title} [${r.env}] ${r.durationMs}ms`)
    for (const s of r.steps) stepLines(s, '  ', out)
    const t = r.totals
    out.push(
      `  ${t.passed}/${t.steps} steps passed, ${t.assertions.passed} assertions passed, ${t.assertions.failed} failed${t.skipped ? `, ${t.skipped} skipped` : ''}`,
    )
  }
  return stripAnsi(out.join('\n'))
}

const esc = (s: unknown) =>
  String(s).replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: characters XML 1.0 forbids
    /[<>&"']|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? '',
  )

export interface JUnitOptions {
  /** ISO time the run began; shown on each suite */
  timestamp?: string
  hostname?: string
  /** shown as `<properties>` on each suite (env, git sha, seed…) */
  properties?: Record<string, string | undefined>
  /** service → the address its calls go to (origin and base path), for the trace in `<system-out>` */
  origins?: Record<string, string>
}

const leafSteps = (steps: StepResult[]): StepResult[] =>
  steps.flatMap((s) => (s.children?.length ? leafSteps(s.children) : [s]))

/**
 * JUnit XML: one suite per flow or request, one case per step (named `flow › step`, class = the project file), failures
 * with the expected and received values, errors with their message, skipped steps, a flow that passed on a retry as a
 * `<flakyFailure>`, and the redacted request/response trace in `<system-out>`.
 */
export function toJUnit(results: RunResult[], o: JUnitOptions = {}): string {
  const suites = results.map((r) => {
    const flat = leafSteps(r.steps)
    const failures = flat.filter((s) => s.status === 'fail').length
    const errors = flat.filter((s) => s.status === 'error').length
    const skipped = flat.filter((s) => s.status === 'skipped').length
    const props = Object.entries({ env: r.env, seed: r.seed, ...o.properties })
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `      <property name="${esc(k)}" value="${esc(v)}"/>`)
      .join('\n')
    const cases = flat
      .map((s) => {
        const time = (s.durationMs / 1000).toFixed(3)
        const failed = s.assertions.filter((a) => !a.pass)
        let inner = ''
        if (s.status === 'skipped') inner = '<skipped/>'
        else if (s.status === 'error')
          inner = `<error message="${esc(s.error ?? 'error')}" type="Error">${esc(s.error ?? 'error')}</error>`
        else if (failed.length) {
          inner = failed
            .map((a) => {
              const lines = diffAssertion(a)
                .filter((l) => l.kind !== 'skip')
                .map(
                  (l) =>
                    `${l.kind === 'expected' ? '- ' : l.kind === 'received' ? '+ ' : '  '}${l.text}`,
                )
              const at = a.location
                ? `\nat ${a.location.file}:${a.location.line}:${a.location.column ?? 1}`
                : ''
              return `<failure message="${esc(a.label)}" type="${esc(a.operator)}">${esc(`${lines.join('\n')}${at}`)}</failure>`
            })
            .join('')
        }
        if (r.flaky && s.status === 'pass' && (r.attempts ?? 1) > 1)
          inner += `<flakyFailure message="passed on attempt ${r.attempts}"/>`
        const trace =
          s.status === 'fail' || s.status === 'error'
            ? `<system-out>${esc(traceLines(s, { origins: o.origins }).join('\n'))}</system-out>`
            : ''
        return `    <testcase classname="${esc(r.file ?? r.id)}" name="${esc(`${r.title} › ${s.name}`)}" time="${time}">${inner}${trace}</testcase>`
      })
      .join('\n')
    const stamp = r.startedAt || o.timestamp
    return `  <testsuite name="${esc(r.title)}" tests="${flat.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${(r.durationMs / 1000).toFixed(3)}"${stamp ? ` timestamp="${esc(stamp)}"` : ''}${o.hostname ? ` hostname="${esc(o.hostname)}"` : ''}>\n    <properties>\n${props}\n    </properties>\n${cases}\n  </testsuite>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join('\n')}\n</testsuites>\n`
}

export const toJson = (results: RunResult[]) => JSON.stringify(results, null, 2)

/** 0 pass, 1 assertion/step failure, 2 run error. */
export function exitCode(results: RunResult[]): 0 | 1 | 2 {
  if (results.some((r) => r.status === 'error')) return 2
  if (results.some((r) => r.status === 'fail')) return 1
  return 0
}

/** For `specbook test`: 0 when every flow passed (a flaky one counts), 1 when any failed or errored. */
export function testExitCode(results: RunResult[]): 0 | 1 {
  return results.some((r) => r.status !== 'pass') ? 1 : 0
}

export interface GithubOptions {
  /** folder the paths are made relative to (the project or repository root) */
  cwd?: string
}

/** A workflow command property: `%`, newlines, `:` and `,` are escaped. */
const prop = (v: string) =>
  v
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C')
const data = (v: string) => v.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

/** GitHub Actions workflow commands: one annotation per failing assertion/step, a warning for a flaky flow. */
export function formatGithub(results: RunResult[], o: GithubOptions = {}): string {
  const rel = (f: string) => (o.cwd && f.startsWith(`${o.cwd}/`) ? f.slice(o.cwd.length + 1) : f)
  const lines: string[] = []
  const visit = (r: RunResult, s: StepResult) => {
    for (const c of s.children ?? []) visit(r, c)
    if (s.children?.length) return
    const title = prop(`${r.title}: ${s.name}`)
    const file = r.file ? `file=${prop(r.file)},` : ''
    if (s.status === 'error')
      lines.push(`::error ${file}title=${title}::${data(s.error ?? 'error')}`)
    if (s.status === 'skipped' || s.status === 'error') return
    for (const a of s.assertions.filter((x) => !x.pass)) {
      const loc = a.location ? `file=${prop(rel(a.location.file))},line=${a.location.line},` : file
      lines.push(`::error ${loc}title=${title}::${data(a.label)}`)
    }
  }
  for (const r of results) {
    for (const s of r.steps) visit(r, s)
    if (r.flaky)
      lines.push(
        `::warning ${r.file ? `file=${prop(r.file)},` : ''}title=${prop(`${r.title}: flaky`)}::${data(`passed on attempt ${r.attempts}`)}`,
      )
  }
  const ok = results.filter((r) => r.status === 'pass').length
  lines.push(`${ok}/${results.length} runs passed`)
  return lines.join('\n')
}

/** Markdown for `$GITHUB_STEP_SUMMARY`: totals, a table of flows, and what failed. */
export function githubSummary(
  results: RunResult[],
  meta: { env: string; runUrl?: string } = { env: '' },
): string {
  const t = reportTotals(results)
  const mark = (r: RunResult) =>
    r.status === 'pass' ? (r.flaky ? '⚠️ flaky' : '✅') : r.status === 'error' ? '❗ error' : '❌'
  const cell = (s: string) => s.replace(/\|/g, '\\|')
  const lines = [
    `### specbook test${meta.env ? ` · ${meta.env}` : ''}`,
    '',
    `**${t.flows.passed}** passed · **${t.flows.failed + t.flows.errored}** failed · **${t.flows.flaky}** flaky · ${results.length} total`,
    '',
    '| | Flow | Steps | Assertions | Time |',
    '| --- | --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${mark(r)} | ${cell(r.title)} | ${r.totals.passed}/${r.totals.steps} | ${r.totals.assertions.passed}/${r.totals.assertions.passed + r.totals.assertions.failed} | ${(r.durationMs / 1000).toFixed(2)}s |`,
    ),
  ]
  const bad = results.flatMap((r) =>
    leafSteps(r.steps)
      .filter((s) => s.status === 'fail' || s.status === 'error')
      .map((s) => ({ r, s })),
  )
  if (bad.length) {
    lines.push('', '#### Failures', '')
    for (const { r, s } of bad) {
      lines.push(`- **${cell(r.title)} › ${cell(s.name)}**`)
      if (s.error) lines.push(`  - ${s.error}`)
      for (const a of s.assertions.filter((x) => !x.pass)) lines.push(`  - ${a.label}`)
    }
  }
  if (meta.runUrl) lines.push('', `[Run](${meta.runUrl})`)
  return `${lines.join('\n')}\n`
}

export * from './ci'
export * from './color'
export * from './envelope'
export * from './list'
export * from './redact'
export * from './trace'
