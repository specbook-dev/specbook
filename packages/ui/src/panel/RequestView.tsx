import type { RenderedRequest } from '@specbook/core/internal'
import { useMemo, useState } from 'preact/hooks'
import { fieldDoc } from '../fielddoc'
import { type Defs, type JsonSchema, linePaths } from '../schema'
import { BodyEditor } from './BodyEditor'
import { FieldDoc } from './FieldDoc'
import { show } from './short'

const pretty = (v: unknown) => (typeof v === 'string' ? v : show(v, 2))

/** Repeated keys for arrays, as the transport sends them. */
export function queryString(query: Record<string, string | string[]>) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query))
    for (const x of Array.isArray(v) ? v : [v]) p.append(k, x)
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** What the spec says about the fields: the request schema (`{ path, query, headers, data }`). */
export interface RequestDocs {
  schema?: JsonSchema
  defs?: Defs
}

/** The body as sent, with the documentation of the field the cursor is on below it. */
function SentBody({ body, docs }: { body: unknown; docs?: RequestDocs }) {
  const [line, setLine] = useState(0)
  const text = pretty(body)
  const documented = !!docs?.schema && typeof body === 'object' && body !== null
  const paths = useMemo(() => (documented ? linePaths(text) : []), [documented, text])
  const doc = useMemo(() => {
    const p = paths[line]
    return p && docs ? fieldDoc(docs.schema, docs.defs, p, ['data'], body) : undefined
  }, [paths, line, docs, body])
  return (
    <>
      <BodyEditor
        label="Body as sent"
        value={text}
        readOnly
        language={typeof body === 'string' ? 'text' : 'json'}
        onLine={setLine}
      />
      {documented && <FieldDoc doc={doc} />}
    </>
  )
}

/** The request exactly as it went out: method, URL, headers and body after placeholders were filled. */
export function RequestView({
  request,
  hideBar,
  docs,
}: {
  request?: RenderedRequest
  /** the surrounding view already shows the method and URL */
  hideBar?: boolean
  /** when given, a field's description is shown as the cursor moves through the body */
  docs?: RequestDocs
}) {
  if (!request)
    return (
      <div class="rs-empty">
        <strong>Nothing sent yet</strong>
        <span class="muted">The request, with every value filled in, appears here after Send.</span>
      </div>
    )
  const headers = Object.entries(request.headers)
  return (
    <div class="sent-view">
      {!hideBar && (
        <div class="rq-bar">
          <span class={`method ${request.method}`}>{request.method}</span>
          <div class="rq-url" title={request.url}>
            <code>
              {request.url}
              {queryString(request.query)}
            </code>
          </div>
        </div>
      )}
      <h3>Headers</h3>
      {headers.length === 0 ? (
        <p class="muted">No headers.</p>
      ) : (
        <table class="headers">
          <tbody>
            {headers.map(([k, v]) => (
              <tr>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {request.body !== undefined && (
        <>
          <h3>Body</h3>
          <SentBody body={request.body} docs={docs} />
        </>
      )}
    </div>
  )
}
