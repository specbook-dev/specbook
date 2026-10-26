import type { Encoding, StepResult } from '@specbook/core'
import { useEffect, useState } from 'preact/hooks'
import { engine, registry } from '../runtime'
import type { Defs, JsonSchema } from '../schema'
import { statusClass, statusName } from '../status'
import { version } from '../store'
import { StepCodeSample } from './CodeSample'
import { queryString, RequestView } from './RequestView'
import { ResponseView } from './ResponseView'
import { ScriptExchange } from './ScriptExchange'

/**
 * The selected step of a run, laid out like an operation: a bar with method, URL and result, then
 * Request and Response tabs (the response checked against the operation's schema).
 */
export function StepExchange(props: { step: StepResult; note?: string; services?: string[] }) {
  // a script has no request or response: it is shown as what it was given and what it returned
  if (props.step.kind === 'script') return <ScriptExchange {...props} />
  return <RequestExchange {...props} />
}

function RequestExchange({
  step,
  note,
  services,
}: {
  step: StepResult
  note?: string
  services?: string[]
}) {
  const [tab, setTab] = useState<'request' | 'response'>('response')
  const [schemas, setSchemas] = useState<Record<string, JsonSchema>>()
  const [defs, setDefs] = useState<Defs>()
  const [reqSchema, setReqSchema] = useState<JsonSchema>()
  const [encoding, setEncoding] = useState<Encoding>('json')
  const req = step.request
  const key = req?.opId ? `${req.service}/${req.opId}` : undefined

  useEffect(() => {
    setTab('response')
  }, [step.name])

  useEffect(() => {
    let live = true
    setSchemas(undefined)
    setDefs(undefined)
    setReqSchema(undefined)
    if (key && req) {
      registry.schemas[key]?.().then(
        (m: { default: JsonSchema }) => live && setReqSchema(m.default),
      )
      engine
        .operationMeta(key, version.value)
        .then((m) => live && setEncoding(m?.encoding ?? 'json'))
      registry.responseSchemas[key]?.().then(
        (m: { default: Record<string, JsonSchema> }) => live && setSchemas(m.default),
      )
      registry.definitions[req.service]?.().then(
        (m: { default: Defs }) => live && setDefs(m.default),
      )
    }
    return () => {
      live = false
    }
  }, [key])

  const response = step.response
  const url = req ? `${req.url}${queryString(req.query)}` : ''

  return (
    <div class="step-exchange">
      {req && (
        <div class="rq-bar">
          <span class={`method ${req.method}`}>{req.method}</span>
          <div class="rq-url" title={url}>
            <code>{url}</code>
          </div>
          {response && (
            <span class={`result-chip ${statusClass(response.status)}`}>
              {response.status} {statusName(response.status)} · {response.durationMs} ms
            </span>
          )}
        </div>
      )}

      {note && (
        <details class="step-about" key={step.name}>
          <summary>About this step</summary>
          <div class="doc-custom" dangerouslySetInnerHTML={{ __html: note }} />
        </details>
      )}

      <div class="rq-tabs" role="tablist">
        {(
          [
            ['request', 'Request'],
            ['response', 'Response'],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === id}
            class={`rq-tab ${tab === id ? 'on' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'response' && response && (
              <span class={`state-dot ${statusClass(response.status)}`}>{response.status}</span>
            )}
          </button>
        ))}
      </div>

      <div class="rq-pane">
        <div class="tab-pane" hidden={tab !== 'request'}>
          {req ? (
            <StepCodeSample
              request={req}
              encoding={encoding}
              sent={<RequestView request={req} hideBar docs={{ schema: reqSchema, defs }} />}
            />
          ) : (
            <RequestView request={req} hideBar docs={{ schema: reqSchema, defs }} />
          )}
        </div>
        <div class="tab-pane" hidden={tab !== 'response'}>
          <ResponseView step={step} schemas={schemas} defs={defs} hideRequest services={services} />
        </div>
      </div>
    </div>
  )
}
