import type { RunResult, StepResult } from '@specbook/core'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { EnvBadge } from '../components/EnvBadge'
import { defaultFor, type FieldSpec, specFromControl } from '../components/Fields'
import type { SequenceInfo } from '../engine'
import { engine } from '../runtime'
import { env, locale, seed, version } from '../store'
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
      if (n.kind === 'step' && typeof n.def !== 'function') names.add(n.def.op.service)
      else if (n.kind === 'step' || n.kind === 'each') return undefined
    }
    return [...names]
  }, [seq])
  const [inputs, setInputs] = useState<Record<string, unknown>>({})
  const [result, setResult] = useState<RunResult>()
  const [live, setLive] = useState<Live>({})
  const [running, setRunning] = useState(false)
  const [pause, setPause] = useState<{
    name: string
    controls: Record<string, FieldSpec>
    resolve: (v: Record<string, unknown>) => void
  }>()
  const [choice, setChoice] = useState<Record<string, unknown>>({})
  const [picked, setPicked] = useState<number>(0)
  // a phone shows the selected step's request and response as a sheet over the timeline
  const [sheet, setSheet] = useState(false)
  const [error, setError] = useState<string>()

  const hasGenerated = Object.values(specs).some((s) => s.generate)
  // a flow with inputs can run on their defaults alone, as `specbook test` does
  const hasInputs = Object.keys(specs).length > 0 || seq.nodes.some((n) => n.kind === 'input')

  /** Every input at its default; a generated one needs faker, which is made ready first. */
  const freshInputs = async () => {
    if (hasGenerated)
      await engine.fakerReady(version.value, locale.value, seed.value).catch(() => {})
    return Object.fromEntries(Object.entries(specs).map(([k, v]) => [k, defaultFor(v)]))
  }

  useEffect(() => {
    let current = true
    const start = (v: Record<string, unknown>) => ({ ...v, ...(preset ?? {}) })
    setInputs(start(Object.fromEntries(Object.entries(specs).map(([k, v]) => [k, defaultFor(v)]))))
    // generated values need faker: fill them in as soon as it is ready
    if (hasGenerated)
      void freshInputs().then((v) => {
        if (!current) return
        setInputs(start(v))
        if (autoRun) void run({ inputs: start(v), headless: true })
      })
    else if (autoRun)
      void run({
        inputs: start(
          Object.fromEntries(Object.entries(specs).map(([k, v]) => [k, defaultFor(v)])),
        ),
        headless: true,
      })
    setResult(undefined)
    setLive({})
    setPause(undefined)
    return () => {
      current = false
    }
  }, [info.file])

  const planned = seq.nodes.map((n) => n.name)
  const rows: { name: string; step?: StepResult }[] = result
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
          if (e.type === 'step:end') setLive((l) => ({ ...l, [e.name]: e.status }))
        },
        onInput: options.headless
          ? undefined
          : ({ name, controls }) =>
              new Promise((resolve) => {
                const c = controls as Record<string, FieldSpec>
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
      // a run that did not pass shows its first failing step, not its first step
      const bad = r.steps
        .filter((s) => s.kind !== 'auth')
        .findIndex((s) => s.status === 'fail' || s.status === 'error')
      if (bad >= 0) setPicked(bad)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      stopper.current = undefined
      setRunning(false)
      setPause(undefined)
    }
  }

  const overall = result?.status

  return (
    <div class={`sequence-panel ${sheet && current ? 'sheet-open' : ''}`} data-seq={seq.meta.id}>
      <div class="seq-left">
        <SecretsBar services={serviceNames} />
        <ControlsGrid title="Inputs" specs={specs} values={inputs} onChange={setInputs} />
        <div class="seq-run">
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
            <span class={`badge ${overall}`}>
              {ICON[overall as 'pass']}{' '}
              {overall === 'pass'
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
        <ol class="journey" part="timeline" aria-label="Timeline">
          {rows.map((row, i) => {
            const step = row.step
            const status = step?.status ?? live[row.name] ?? 'pending'
            const failed = step?.assertions.filter((a) => !a.pass) ?? []
            return (
              <li class={`jstep ${status} ${picked === i ? 'picked' : ''}`}>
                <div class="jmark">{ICON[status as keyof typeof ICON] || i + 1}</div>
                <div class="jbody">
                  <button
                    type="button"
                    class="jhead"
                    disabled={!step}
                    onClick={(e) => {
                      const row = e.currentTarget
                      setPicked(i)
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
                      {stopped
                        ? 'Skipped: you stopped the run.'
                        : 'Skipped: an earlier step did not pass.'}
                    </div>
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

      <div class={`seq-right ${sheet && current ? 'sheet-open' : ''}`}>
        {current && (
          <button
            type="button"
            class="sheet-close"
            aria-label="Hide step details"
            onClick={() => setSheet(false)}
          >
            <span aria-hidden="true">⌄</span> {current.name}
          </button>
        )}
        {!current && (
          <div class="rs-empty">
            <strong>Nothing run yet</strong>
            <span class="muted">Press Run, then pick a step to see its request and response.</span>
          </div>
        )}
        {current && <StepExchange step={current} note={notes.notes.get(baseName(current.name))} />}
      </div>
    </div>
  )
}
