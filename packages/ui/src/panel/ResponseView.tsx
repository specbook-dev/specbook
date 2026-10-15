import type { StepResult } from '@specbook/core'
import { useMemo, useState } from 'preact/hooks'
import { fieldDoc } from '../fielddoc'
import { type Defs, type JsonSchema, linePaths, validate } from '../schema'
import { statusClass, statusName } from '../status'
import { BodyEditor } from './BodyEditor'
import { FieldDoc } from './FieldDoc'
import { PaperPlane } from './icons'
import { queryString } from './RequestView'

interface Props {
  step?: StepResult
  error?: string
  schemas?: Record<string, JsonSchema>
  defs?: Defs
  /** the request is shown elsewhere */
  hideRequest?: boolean
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2)
const size = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

export function ResponseView({ step, error, schemas, defs, hideRequest }: Props) {
  const [tab, setTab] = useState<'body' | 'headers' | 'checks'>('body')
  const [line, setLine] = useState(0)
  const response = step?.response
  const schema = response ? (schemas?.[String(response.status)] ?? schemas?.default) : undefined
  const issues = useMemo(
    () => (response && schema ? validate(response.body, schema, defs, { reportExtra: true }) : []),
    [response, schema, defs],
  )
  const text =
    response === undefined || response.body === undefined || response.body === ''
      ? ''
      : typeof response.body === 'string'
        ? response.body
        : pretty(response.body)
  const paths = useMemo(() => linePaths(text), [text])
  const doc = useMemo(() => {
    const p = paths[line]
    return p ? fieldDoc(schema, defs, p) : undefined
  }, [paths, line, schema, defs])
  const checks = step?.assertions ?? []
  const failed = checks.filter((a) => !a.pass).length
  const headers = Object.entries(response?.headers ?? {})
  const empty = !response && !error && !step?.error

  return (
    <section class="response" aria-label="Response">
      <div class="rs-head">
        {response && (
          <>
            <span class={`state-badge ${statusClass(response.status)}`}>
              {response.status} {statusName(response.status)}
            </span>
            <span class="rs-stat">{response.durationMs} ms</span>
            <span class="rs-stat">{size(new Blob([text]).size)}</span>
          </>
        )}
        <span class="spacer" />
        {response && (
          <span class={`conf ${schema ? (issues.length ? 'warn' : 'ok') : 'none'}`}>
            {schema
              ? issues.length
                ? `⚠ ${issues.length} difference${issues.length > 1 ? 's' : ''} from spec`
                : '✓ Matches spec'
              : 'No schema for this response'}
          </span>
        )}
      </div>

      {step?.request && !hideRequest && (
        <p class="sent">
          <span class={`method ${step.request.method}`}>{step.request.method}</span>{' '}
          <code>
            {step.request.url}
            {queryString(step.request.query)}
          </code>
        </p>
      )}
      {error && <p class="error-text">{error}</p>}
      {step?.error && <p class="error-text">{step.error}</p>}
      {empty && (
        <div class="rs-empty">
          <strong>No response yet</strong>
          <span class="muted">
            Press{' '}
            <kbd class="icon-key">
              <PaperPlane size={12} />
            </kbd>{' '}
            or <kbd>⌘</kbd> <kbd>↵</kbd>
          </span>
        </div>
      )}

      {response && (
        <>
          <div class="rq-tabs" role="tablist">
            {(
              [
                ['body', 'Body', 0],
                ['headers', 'Headers', headers.length],
                ['checks', 'Checks', checks.length],
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
                  <span class={`count ${id === 'checks' && failed ? 'bad' : ''}`}>{n}</span>
                )}
              </button>
            ))}
          </div>
          <div class="rs-pane">
            <div hidden={tab !== 'body'}>
              {text === '' ? (
                <p class="muted">No content.</p>
              ) : (
                <BodyEditor
                  label="Response body"
                  value={text}
                  readOnly
                  language={typeof response.body === 'string' ? 'text' : 'json'}
                  onLine={setLine}
                />
              )}
              {text !== '' && <FieldDoc doc={doc} />}
              {issues.length > 0 && (
                <details class="issues">
                  <summary>What differs</summary>
                  <ul>
                    {issues.map((i) => (
                      <li>
                        <code>{i.path || '(root)'}</code> {i.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <div hidden={tab !== 'headers'}>
              <table class="headers">
                <tbody>
                  {headers.map(([k, v]) => (
                    <tr>
                      <th>{k}</th>
                      <td>{v}</td>
                    </tr>
                  ))}
                  {headers.length === 0 && (
                    <tr>
                      <td class="muted">No headers recorded</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div hidden={tab !== 'checks'}>
              {checks.length === 0 ? (
                <p class="muted">This request has no checks.</p>
              ) : (
                <ul class="checks">
                  {checks.map((a) => (
                    <li class={a.pass ? 'ok' : 'bad'}>
                      {a.pass ? '✓' : '✗'} {a.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}
