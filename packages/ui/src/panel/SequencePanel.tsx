import { flowSkipReason, type RunResult, type StepResult } from '@specbook/core/internal'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { Security } from '../auth-options'
import { EnvBadge } from '../components/EnvBadge'
import {
  anyGenerated,
  defaultFor,
  type FieldSpec,
  specFromControl,
  startValues,
  summarize,
} from '../components/Fields'
import type { SequenceInfo } from '../engine'
import { NARROW, useMedia } from '../media'
import { engine } from '../runtime'
import { env, fakerInUse, locale, seed, version } from '../store'
import { announcement, describeRun } from './announce'
import { Failure } from './Checks'
import { ControlsGrid } from './ControlsGrid'
import { SecretsBar } from './SecretsBar'
import { StepExchange } from './StepExchange'
import { short, show } from './short'
import { useSequenceNotes } from './stepnotes'

/** `Check items #2` belongs to the step `Check items`. */
const baseName = (n: string) => n.replace(/ #\d+$/, '')

type Live = Record<string, 'running' | 'pass' | 'fail' | 'error' | 'skipped' | 'paused'>

const ICON = {
  pass: '✓',
  fail: '✗',
  error: '!',
  skipped: '–',
  running: '…',
  paused: '⏸',
  pending: '',
}

/**
 * What was typed into each flow, kept while the panel is away (the Docs tab) or on another flow. Memory only. Generated
 * values depend on the seed and the locale, so a form kept under other ones is not the form to come back to.
 */
const kept = new Map<string, Record<string, unknown>>()

/** |timeline|request|: the journey on the left, the selected step's exchange on the right. */
export function SequencePanel({
  info,
  preset,
  autoRun,
}: {
  info: SequenceInfo
  /** input values to start from instead of the defaults (an embed's data-specbook-inputs) */
  preset?: Record<string, unknown>
  /** run on the defaults as soon as the flow is ready */
  autoRun?: boolean
}) {
  const { seq } = info
  const specs = useMemo(
    () =>
      Object.fromEntries(
        Object.entries((seq.meta.inputs ?? {}) as Record<string, unknown>).map(([k, c]) => [
          k,
          specFromControl(c),
        ]),
      ) as Record<string, FieldSpec>,
    [seq],
  )
  const notes = useSequenceNotes(info)
  // the services the flow calls; steps built by functions are only known when they run, so any such step asks for all
  const serviceNames = useMemo(() => {
    const names = new Set<string>()
    for (const n of seq.nodes) {
      if (n.kind === 'step' && typeof n.def !== 'function') {
        // a script calls no operation of the spec: it adds no service and does not make the list unknown
        if (n.def.kind === 'request') names.add(n.def.op.service)
      } else if (n.kind === 'step' || n.kind === 'each') return undefined
    }
    return [...names]
  }, [seq])
  // what the spec says each of those steps accepts, per service, so the bar can offer the ways they all accept
  const securities = useMemo(() => {
    const out: Record<string, Security[]> = {}
    for (const n of seq.nodes)
      if (n.kind === 'step' && typeof n.def !== 'function' && n.def.kind === 'request')
        out[n.def.op.service] = [...(out[n.def.op.service] ?? []), n.def.op.security]
    return out
  }, [seq])
  // a flow with a script step gives the timeline room for what a script draws in its row (a 300px widget)
  const hasScript = useMemo(
    () =>
      seq.nodes.some(
        (n) =>
          n.kind === 'step' &&
          typeof n.def !== 'function' &&
          n.def.kind === 'script' &&
          n.def.meta.runtime === 'browser',
      ),
    [seq],
  )
  const [inputs, setInputs] = useState<Record<string, unknown>>({})
  const [result, setResult] = useState<RunResult>()
  const [live, setLive] = useState<Live>({})
  const [running, setRunning] = useState(false)
  const [pause, setPause] = useState<{
    name: string
    controls: Record<string, FieldSpec>
    resolve: (v: Record<string, unknown>) => void
  }>()
  // a script step that is waiting for a container to render into: it gets the element once it is on the page
  const [stage, setStage] = useState<{ name: string; resolve: (el: HTMLElement) => void }>()
  const [choice, setChoice] = useState<Record<string, unknown>>({})
  const [picked, setPicked] = useState<number>(0)
  // a phone shows the selected step's request and response as a sheet over the timeline
  const [sheet, setSheet] = useState(false)
  const [error, setError] = useState<string>()
  // the Inputs stop of the timeline: on a wide screen it is the view of the right pane, on a narrow one the form unfolds under it
  const keptKey = `${info.file}|${seed.value}|${locale.value}`
  const [inputsOpen, setInputsOpen] = useState(true)
  const narrow = useMedia(NARROW)

  const hasGenerated = Object.values(specs).some(anyGenerated)
  // a flow with inputs can run on their defaults alone, as `specbook test` does
  const hasInputs = Object.keys(specs).length > 0 || seq.nodes.some((n) => n.kind === 'input')

  useEffect(() => {
    fakerInUse.value = hasGenerated
    return () => {
      fakerInUse.value = false
    }
  }, [hasGenerated])

  /** Every input at its default; a generated one needs faker, which is made ready first. */
  const freshInputs = async () => {
    if (hasGenerated)
      await engine.fakerReady(version.value, locale.value, seed.value).catch(() => {})
    return startValues(specs, preset)
  }

  useEffect(() => {
    let current = true
    // a button that names its own starting values (an embed's data-specbook-inputs) means them, whatever an earlier open of
    // the same flow left behind; with none named, the flow comes back as it was left
    const named = !!preset && Object.keys(preset).length > 0
    const saved = named ? undefined : kept.get(keptKey)
    if (saved) {
      // back on a flow that was being filled in: what was typed is still there, and nothing runs by itself
      setInputs(startValues(specs, saved))
      if (hasGenerated)
        void engine.fakerReady(version.value, locale.value, seed.value).catch(() => {})
    } else {
      setInputs(startValues(specs, preset))
      // generated values need faker: fill them in as soon as it is ready
      if (hasGenerated)
        void freshInputs().then((v) => {
          if (!current) return
          setInputs(v)
          if (autoRun) void run({ inputs: v, headless: true })
        })
      else if (autoRun) void run({ inputs: startValues(specs, preset), headless: true })
    }
    setInputsOpen(true)
    setResult(undefined)
    setLive({})
    setPause(undefined)
    setStage(undefined)
    return () => {
      current = false
    }
  }, [info.file])

  useEffect(() => {
    if (Object.keys(inputs).length > 0) kept.set(keptKey, inputs)
  }, [inputs])

  const planned = seq.nodes.map((n) => n.name)
  // inputs that could not be made into values end the run before any step: the timeline stays as planned
  const bad0 = result?.steps[0]
  const inputsFailed =
    result?.steps.length === 1 &&
    bad0?.kind === 'input' &&
    bad0.name === 'inputs' &&
    bad0.status === 'error'
  const rows: { name: string; step?: StepResult }[] =
    result && !inputsFailed
      ? result.steps.filter((s) => s.kind !== 'auth').map((s) => ({ name: s.name, step: s }))
      : planned.map((n) => ({ name: n }))
  const current = rows[picked]?.step

  /** ends the run that is going: what is out is stopped, and nothing after it starts */
  const stopper = useRef<AbortController | undefined>(undefined)
  const [stopped, setStopped] = useState(false)
  const stop = () => {
    setStopped(true)
    stopper.current?.abort()
    // a run waiting for a choice is released, and then finds it is stopped
    pause?.resolve(choice)
  }

  const run = async (options: { inputs?: Record<string, unknown>; headless?: boolean } = {}) => {
    const ctl = new AbortController()
    stopper.current = ctl
    setStopped(false)
    setRunning(true)
    setResult(undefined)
    setError(undefined)
    setLive({})
    setPicked(0)
    setSheet(false)
    // a narrow screen shows the run: the form folds away
    if (narrow) setInputsOpen(false)
    try {
      const r = await engine.run(seq, {
        env: env.value,
        version: version.value,
        inputs: options.inputs ?? inputs,
        locale: locale.value,
        seed: seed.value,
        signal: ctl.signal,
        onEvent: (e) => {
          if (e.type === 'step:start') setLive((l) => ({ ...l, [e.name]: 'running' }))
          if (e.type === 'step:end') {
            setLive((l) => ({ ...l, [e.name]: e.status }))
            // a script's container goes with its step
            setStage((s) => (s?.name === e.name ? undefined : s))
          }
        },
        // a script renders into a container in its own row; it is made when the script asks for it, and ends with the step
        mount: (name, stopSignal) =>
          new Promise<HTMLElement>((resolve, reject) => {
            let done = false
            const entry = {
              name,
              resolve: (el: HTMLElement) => {
                if (done) return
                done = true
                resolve(el)
              },
            }
            setStage(entry)
            stopSignal?.addEventListener(
              'abort',
              () => {
                setStage((s) => (s === entry ? undefined : s))
                if (done) return
                done = true
                reject(new Error('Stopped before the step finished.'))
              },
              { once: true },
            )
          }),
        onInput: options.headless
          ? undefined
          : ({ name, controls }) =>
              new Promise((resolve) => {
                const c = controls as unknown as Record<string, FieldSpec>
                setLive((l) => ({ ...l, [name]: 'paused' }))
                setChoice(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, defaultFor(v)])))
                setPause({
                  name,
                  controls: c,
                  resolve: (values) => {
                    setPause(undefined)
                    resolve(values)
                  },
                })
              }),
      })
      setResult(r)
      announcement.value = describeRun(r)
      const first = r.steps[0]
      if (
        r.steps.length === 1 &&
        first?.kind === 'input' &&
        first.name === 'inputs' &&
        first.status === 'error'
      )
        setInputsOpen(true)
      else {
        // a run that did not pass shows its first failing step, not its first step
        const bad = r.steps
          .filter((s) => s.kind !== 'auth')
          .findIndex((s) => s.status === 'fail' || s.status === 'error')
        setInputsOpen(false)
        if (bad >= 0) setPicked(bad)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      stopper.current = undefined
      setRunning(false)
      setPause(undefined)
      setStage(undefined)
    }
  }

  // the Run row sticks to the top of a narrow screen: what scrolls to the top of the screen must clear it
  const left = useRef<HTMLDivElement>(null)
  const runRow = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = runRow.current
    const box = left.current
    if (!row || !box || typeof ResizeObserver === 'undefined') return
    const measure = () => box.style.setProperty('--seq-run-h', `${row.offsetHeight}px`)
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(row)
    return () => watch.disconnect()
  }, [])

  const overall = result?.status
  // a flow whose scripts need what this page is not (node), before it runs or after it was left out of a run
  const unmet = result?.skipped ?? flowSkipReason(seq, 'browser', env.value)
  const hasForm = Object.keys(specs).length > 0
  // the form is drawn in one place: under its stop on a narrow screen, in the right pane on a wide one
  const form = (
    <fieldset class="seq-form" disabled={running}>
      <ControlsGrid title="Inputs" specs={specs} values={inputs} onChange={setInputs} />
    </fieldset>
  )
  const formInRight = !narrow && hasForm && (inputsOpen || !current)
  const inputsError = inputsFailed ? bad0?.error : undefined

  return (
    <div
      class={`sequence-panel ${sheet && current ? 'sheet-open' : ''} ${hasScript ? 'has-script' : ''}`}
      data-seq={seq.meta.id}
    >
      <div class="seq-left" ref={left}>
        <SecretsBar services={serviceNames} securities={securities} />
        <div class="seq-run" ref={runRow}>
          <button type="button" class="btn primary" disabled={running} onClick={() => run()}>
            {running ? 'Running…' : '▶ Run'}
          </button>
          {running && (
            <button type="button" class="btn" onClick={stop}>
              Stop
            </button>
          )}
          {hasInputs && (
            <button
              type="button"
              class="btn"
              disabled={running}
              title="Skip every question and use each input's default, as specbook test does"
              onClick={async () => {
                const fresh = await freshInputs()
                setInputs(fresh)
                await run({ inputs: fresh, headless: true })
              }}
            >
              Run with defaults
            </button>
          )}
          <EnvBadge />
          {result && (
            <span class={`badge ${result.skipped ? 'skipped' : overall}`}>
              {ICON[result.skipped ? 'skipped' : (overall as 'pass')]}{' '}
              {result.skipped
                ? 'Skipped'
                : overall === 'pass'
                  ? 'Passed'
                  : stopped
                    ? 'Stopped'
                    : overall === 'fail'
                      ? 'Failed'
                      : 'Error'}{' '}
              · {result.totals.passed}/{result.totals.steps} steps · {result.durationMs}ms
            </span>
          )}
        </div>
        {error && <p class="error-text">{error}</p>}
        {unmet && (
          <p class="muted seq-unmet" role="status">
            {unmet}
          </p>
        )}
        <ol class="journey" part="timeline" aria-label="Timeline">
          {hasForm && (
            <li class={`jin ${inputsOpen ? 'open' : ''} ${inputsError ? 'bad' : ''}`}>
              <button
                type="button"
                class="jin-head"
                aria-expanded={narrow ? inputsOpen : undefined}
                aria-current={!narrow && inputsOpen ? 'step' : undefined}
                onClick={() => {
                  setInputsOpen(narrow ? !inputsOpen : true)
                  setSheet(false)
                }}
              >
                <span class="jname">Inputs</span>
                <span class={`count ${inputsError ? 'bad' : ''}`}>
                  {inputsError ? '!' : Object.keys(specs).length}
                </span>
                <span class="jin-sum muted">{summarize(specs, inputs)}</span>
              </button>
              {inputsError && <div class="error-text">{inputsError}</div>}
              {narrow && inputsOpen && <div class="jin-form">{form}</div>}
            </li>
          )}
          {rows.map((row, i) => {
            const step = row.step
            const status = step?.status ?? live[row.name] ?? 'pending'
            const failed = step?.assertions.filter((a) => !a.pass) ?? []
            return (
              <li
                class={`jstep ${status} ${picked === i && !(inputsOpen && !narrow) ? 'picked' : ''}`}
              >
                <div class="jmark">{ICON[status as keyof typeof ICON] || i + 1}</div>
                <div class="jbody">
                  <button
                    type="button"
                    class="jhead"
                    disabled={!step}
                    onClick={(e) => {
                      const row = e.currentTarget
                      setPicked(i)
                      setInputsOpen(false)
                      setSheet(true)
                      // keep the tapped step visible above the sheet that is about to cover the bottom
                      requestAnimationFrame(() =>
                        row.scrollIntoView?.({ block: 'start', behavior: 'smooth' }),
                      )
                    }}
                  >
                    <span class="jname">{row.name}</span>
                    {step?.response && (
                      <span class="muted">
                        {step.response.status} · {step.durationMs}ms
                      </span>
                    )}
                    {step?.kind === 'script' && step.status !== 'skipped' && (
                      <span class="muted">
                        {step.script?.runtime} · {step.durationMs}ms
                      </span>
                    )}
                    {step && step.assertions.length > 0 && (
                      <span class={failed.length ? 'error-text' : 'muted'}>
                        {step.assertions.length - failed.length}/{step.assertions.length} checks
                      </span>
                    )}
                  </button>
                  {step?.uses
                    ?.filter((u) => u.source === 'capture')
                    .map((u) => (
                      <span class="cap use" title={`from step "${u.step}"`}>
                        ← {u.key} <em>from {u.step}</em>
                      </span>
                    ))}
                  {step &&
                    Object.entries(step.captured).map(([k, v]) => (
                      <span class="cap make" title={show(v)}>
                        → {k} <b>{short(v)}</b>
                      </span>
                    ))}
                  {step?.error && <div class="error-text">{step.error}</div>}
                  {failed.map((a) => (
                    <Failure a={a} />
                  ))}
                  {status === 'skipped' && (
                    <div class="muted">
                      {step?.note ??
                        (stopped
                          ? 'Skipped: you stopped the run.'
                          : 'Skipped: an earlier step did not pass.')}
                    </div>
                  )}
                  {stage && stage.name === row.name && live[row.name] === 'running' && (
                    // the script renders its own surface here (a button, a frame); it is handed this element, never a selector
                    <div
                      class="script-stage"
                      key={`script-stage-${row.name}`}
                      ref={(el) => {
                        if (el) stage.resolve(el)
                      }}
                    />
                  )}
                  {pause && live[row.name] === 'paused' && (
                    <div class="pause">
                      <strong>Your turn: {pause.name}</strong>
                      <ControlsGrid
                        title="Choose"
                        specs={pause.controls}
                        values={choice}
                        onChange={setChoice}
                      />
                      <button
                        type="button"
                        class="btn primary"
                        onClick={() => pause.resolve(choice)}
                      >
                        Continue ▶
                      </button>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      </div>

      <div
        class={`seq-right ${sheet && current ? 'sheet-open' : ''} ${!current && !formInRight ? 'empty' : ''}`}
      >
        {formInRight && <div class="seq-inputs">{form}</div>}
        {!formInRight && current && (
          <button
            type="button"
            class="sheet-close"
            aria-label="Hide step details"
            onClick={() => setSheet(false)}
          >
            <span aria-hidden="true">⌄</span> {current.name}
          </button>
        )}
        {!formInRight && !current && (
          <div class="rs-empty">
            <strong>Nothing run yet</strong>
            <span class="muted">Press Run, then pick a step to see its request and response.</span>
          </div>
        )}
        {!formInRight && current && (
          <StepExchange
            step={current}
            note={notes.notes.get(baseName(current.name))}
            services={serviceNames}
          />
        )}
      </div>
    </div>
  )
}
