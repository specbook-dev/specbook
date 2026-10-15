import { stripAnsi } from '../assert'
import type { RunResult, StepResult } from '../types'

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
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string,
  )

export function toJUnit(results: RunResult[]): string {
  const suites = results.map((r) => {
    const flat: StepResult[] = []
    const walk = (s: StepResult) => (s.children?.length ? s.children.forEach(walk) : flat.push(s))
    r.steps.forEach(walk)
    const failures = flat.filter((s) => s.status === 'fail' || s.status === 'error').length
    const cases = flat
      .map((s) => {
        const time = (s.durationMs / 1000).toFixed(3)
        const failed = s.assertions.filter((a) => !a.pass)
        let inner = ''
        if (s.status === 'skipped') inner = '<skipped/>'
        else if (s.status === 'error') inner = `<error message="${esc(s.error ?? 'error')}"/>`
        else if (failed.length) {
          inner = failed
            .map(
              (a) =>
                `<failure message="${esc(a.label)}">${esc(`expected: ${JSON.stringify(a.expected)}\nactual: ${JSON.stringify(a.actual)}`)}</failure>`,
            )
            .join('')
        }
        return `    <testcase classname="${esc(r.id)}" name="${esc(s.name)}" time="${time}">${inner}</testcase>`
      })
      .join('\n')
    return `  <testsuite name="${esc(r.title)}" tests="${flat.length}" failures="${failures}" time="${(r.durationMs / 1000).toFixed(3)}">\n${cases}\n  </testsuite>`
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

/** GitHub Actions workflow commands: one annotation per failing assertion/step. */
export function formatGithub(results: RunResult[]): string {
  const esc = (v: string) => v.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  const lines: string[] = []
  const visit = (r: RunResult, s: StepResult) => {
    for (const c of s.children ?? []) visit(r, c)
    if (s.status === 'error' || s.status === 'skipped') {
      if (s.status === 'error')
        lines.push(`::error title=${esc(`${r.title}: ${s.name}`)}::${esc(s.error ?? 'error')}`)
      return
    }
    for (const a of s.assertions.filter((x) => !x.pass)) {
      const loc = a.location ? `file=${esc(a.location.file)},line=${a.location.line},` : ''
      lines.push(`::error ${loc}title=${esc(`${r.title}: ${s.name}`)}::${esc(a.label)}`)
    }
  }
  for (const r of results) for (const s of r.steps) visit(r, s)
  const ok = results.filter((r) => r.status === 'pass').length
  lines.push(`${ok}/${results.length} runs passed`)
  return lines.join('\n')
}
