import { type AssertionResult, type DiffLine, diffAssertion } from '@specbook/core'
import { registry } from '../runtime'

/** The project file an assertion failed in, as `file:line`, when its stack names one of the project's requests or flows. */
export function whereOf(a: AssertionResult): string | undefined {
  const loc = a.location
  if (!loc) return undefined
  const files = [...registry.requests, ...registry.sequences].map((e) => e.file)
  // the stack names a file by its address in the page; the longest project path it ends with is the file
  const hit = files.filter((f) => loc.file.includes(f)).sort((a, b) => b.length - a.length)[0]
  return hit ? `${hit}:${loc.line}` : undefined
}

const GUTTER = { expected: '−', received: '+', same: ' ', skip: ' ' } as const
const SPOKEN = { expected: 'expected', received: 'received', same: '', skip: '' } as const

function Diff({ lines }: { lines: DiffLine[] }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a block that scrolls sideways must be reachable by keyboard
    <section class="diff" tabIndex={0} aria-label="Expected and received values">
      {lines.map((l) => (
        <div class={`diff-line diff-${l.kind}`}>
          <span class="diff-gutter" aria-hidden="true">
            {GUTTER[l.kind]}
          </span>
          {SPOKEN[l.kind] && <span class="visually-hidden">{SPOKEN[l.kind]}: </span>}
          <span class="diff-text">{l.text}</span>
        </div>
      ))}
    </section>
  )
}

/** One failed assertion: what it checks, what was expected and received as a colored diff, and where it is. */
export function Failure({ a }: { a: AssertionResult }) {
  const lines = diffAssertion(a)
  const where = whereOf(a)
  return (
    <fieldset class="check-fail">
      <legend class="visually-hidden">Failed check: {a.label}</legend>
      <div class="check-head">
        <span class="check-mark" aria-hidden="true">
          ✗
        </span>
        <strong>{a.label}</strong>
        <span class="chip">{a.operator}</span>
      </div>
      {lines.length > 0 && (
        <>
          <div class="diff-legend" aria-hidden="true">
            <span class="diff-key diff-expected">− Expected</span>
            <span class="diff-key diff-received">+ Received</span>
          </div>
          <Diff lines={lines} />
        </>
      )}
      {where && <div class="check-where">at {where}</div>}
    </fieldset>
  )
}

/** The checks of a step: passing ones in a line, failing ones as cards with their diff. */
export function Checks({ assertions }: { assertions: AssertionResult[] }) {
  return (
    <ul class="checks">
      {assertions.map((a) =>
        a.pass ? (
          <li class="ok">✓ {a.label}</li>
        ) : (
          <li class="bad">
            <Failure a={a} />
          </li>
        ),
      )}
    </ul>
  )
}
