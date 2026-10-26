import type { StepResult } from '@specbook/core'
import { useEffect, useState } from 'preact/hooks'
import { BodyEditor } from './BodyEditor'
import { Checks } from './Checks'
import { ExtensionNudge, replacesMessage } from './ExtensionNudge'
import { show } from './short'

type Tab = 'output' | 'inputs' | 'checks' | 'logs'

/**
 * The selected script step of a run, laid out like a request's exchange: a bar with the script and where it ran, then what
 * it was given (Inputs), what it returned (Output), its checks and what it said (Logs) in place of Request and Response.
 */
export function ScriptExchange({
  step,
  note,
  services,
}: {
  step: StepResult
  note?: string
  services?: string[]
}) {
  const sc = step.script
  const checks = step.assertions
  const failed = checks.filter((a) => !a.pass).length
  const inputs = Object.entries(sc?.inputs ?? {})
  const logs = sc?.logs ?? []
  const [tab, setTab] = useState<Tab>('output')
  // a step that failed a check opens on it: that is what the person came to see
  useEffect(() => {
    setTab(failed > 0 ? 'checks' : 'output')
  }, [step.name, failed])
  const output = sc?.output === undefined ? '' : show(sc.output, 2)

  return (
    <div class="step-exchange">
      <div class="rq-bar">
        <span class="chip">script</span>
        <div class="rq-url" title={sc?.id}>
          <code>{sc?.id ?? step.name}</code>
        </div>
        {sc && <span class="chip">{sc.runtime}</span>}
        <span class={`badge ${step.status}`}>{step.status}</span>
        {step.status !== 'skipped' && <span class="muted">{step.durationMs} ms</span>}
      </div>

      {note && (
        <details class="step-about" key={step.name}>
          <summary>About this step</summary>
          <div class="doc-custom" dangerouslySetInnerHTML={{ __html: note }} />
        </details>
      )}
      {step.note && <p class="muted">{step.note}</p>}
      {step.error && !replacesMessage(step.errorHint) && <p class="error-text">{step.error}</p>}
      <ExtensionNudge hint={step.errorHint} services={services} />

      <div class="rq-tabs" role="tablist">
        {(
          [
            ['output', 'Output', 0],
            ['inputs', 'Inputs', inputs.length],
            ['checks', 'Checks', checks.length],
            ['logs', 'Logs', logs.length],
          ] as const
        ).map(([id, label, n]) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === id}
            class={`rq-tab ${tab === id ? 'on' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
            {n > 0 && (
              <span class={`count ${id === 'checks' && failed ? 'bad' : ''}`}>
                {id === 'checks' && failed ? failed : n}
              </span>
            )}
          </button>
        ))}
      </div>

      <div class="rq-pane">
        <div class="tab-pane" hidden={tab !== 'output'}>
          {output === '' ? (
            <p class="muted">
              {step.status === 'skipped'
                ? 'The script did not run.'
                : 'The script returned nothing.'}
            </p>
          ) : (
            <BodyEditor label="Script output" value={output} readOnly language="json" />
          )}
        </div>
        <div class="tab-pane" hidden={tab !== 'inputs'}>
          <table class="headers">
            <tbody>
              {inputs.map(([k, v]) => (
                <tr>
                  <th>{k}</th>
                  <td>{typeof v === 'string' ? v : show(v)}</td>
                </tr>
              ))}
              {inputs.length === 0 && (
                <tr>
                  <td class="muted">This script takes no inputs.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div class="tab-pane" hidden={tab !== 'checks'}>
          {checks.length === 0 ? (
            <p class="muted">This script has no checks.</p>
          ) : (
            <Checks assertions={checks} />
          )}
        </div>
        <div class="tab-pane" hidden={tab !== 'logs'}>
          {logs.length === 0 ? (
            <p class="muted">The script logged nothing.</p>
          ) : (
            <pre class="script-logs">{logs.join('\n')}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
