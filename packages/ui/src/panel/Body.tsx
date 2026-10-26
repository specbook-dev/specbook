import { type Encoding, fromFormRows, toFormRows } from '@specbook/core/internal'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { type FieldDoc as Doc, fieldDoc, keyPath } from '../fielddoc'
import { type Defs, type JsonSchema, linePaths } from '../schema'
import { BodyEditor } from './BodyEditor'
import { jsonCompletions } from './completions'
import { type Draft, type FieldRow, gridMode } from './draft'
import { FieldDoc } from './FieldDoc'
import { type Graphql, joinGraphql, splitGraphql } from './graphql'
import { ParamGrid } from './ParamGrid'

interface Props {
  encoding: Encoding
  draft: Draft
  onChange: (d: Draft) => void
  /** request schema (`{ path, query, headers, data }`) and shared definitions */
  schema?: JsonSchema
  defs?: Defs
  /** dotted body paths that are uploads */
  files?: string[]
  /** shown, not edited */
  readOnly?: boolean
}

/** Keeps the typed texts locally, so invalid variables JSON isn't rewritten while the user is typing. */
function GraphqlBody({
  draft,
  onChange,
  readOnly,
}: {
  draft: Draft
  onChange: (d: Draft) => void
  readOnly?: boolean
}) {
  const [g, setG] = useState(() => splitGraphql(draft.body) as Graphql)
  const emitted = useRef(draft.body)
  useEffect(() => {
    if (draft.body === emitted.current) return
    const next = splitGraphql(draft.body)
    if (next) setG(next)
    emitted.current = draft.body
  }, [draft.body])

  const set = (part: Partial<Graphql>) => {
    const next = { ...g, ...part }
    setG(next)
    emitted.current = joinGraphql(next)
    onChange({ ...draft, body: emitted.current })
  }
  return (
    <section class="body" aria-label="Body">
      <div class="section-head">
        <h3>Query</h3>
        <span class="chip">graphql</span>
      </div>
      <BodyEditor
        readOnly={readOnly}
        label="GraphQL query"
        language="graphql"
        value={g.query}
        onChange={(query) => set({ query })}
      />
      <div class="section-head">
        <h3>Variables</h3>
        <span class="chip">json</span>
      </div>
      <BodyEditor
        readOnly={readOnly}
        label="GraphQL variables"
        language="json"
        value={g.variables}
        onChange={(variables) => set({ variables })}
      />
    </section>
  )
}

const language = (e: Encoding) => (e === 'graphql' ? 'graphql' : e === 'text' ? 'text' : 'json')

export function Body({ encoding, draft, onChange, schema, defs, files = [], readOnly }: Props) {
  const [line, setLine] = useState(0)
  const paths = useMemo(() => linePaths(draft.body), [draft.body])
  const documented = encoding === 'json' || encoding === 'form'
  // what has been typed, when it is JSON yet: a union in the schema is the variant it names
  const typed = useMemo(() => {
    try {
      return JSON.parse(draft.body)
    } catch {
      return undefined
    }
  }, [draft.body])
  const doc: Doc | undefined = useMemo(() => {
    const p = paths[line]
    return p && documented ? fieldDoc(schema, defs, p, ['data'], typed) : undefined
  }, [paths, line, schema, defs, documented, typed])
  const complete = useMemo(
    () =>
      documented && schema
        ? (text: string, pos: number) => jsonCompletions(schema, defs, ['data'], text, pos)
        : undefined,
    [schema, defs, documented],
  )

  /** Form bodies convert between the nested JSON and the bracket-key rows when the view is switched. */
  const switchView = (view: 'json' | 'grid') => {
    if (view === (draft.formView ?? 'grid')) return
    if (view === 'grid') {
      try {
        onChange({ ...draft, formView: 'grid', fields: toFormRows(JSON.parse(draft.body || '{}')) })
      } catch {
        onChange({ ...draft, formView: 'grid' })
      }
    } else {
      onChange({
        ...draft,
        formView: 'json',
        body: JSON.stringify(fromFormRows(draft.fields.filter((r) => !r.file)), null, 2),
      })
    }
  }
  const viewToggle =
    encoding === 'form' ? (
      <fieldset class="seg" aria-label="Body view">
        {(['json', 'grid'] as const).map((v) => (
          <button
            type="button"
            class={`seg-btn ${(draft.formView ?? 'grid') === v ? 'on' : ''}`}
            aria-pressed={(draft.formView ?? 'grid') === v}
            onClick={() => switchView(v)}
          >
            {v === 'json' ? 'JSON' : 'Grid'}
          </button>
        ))}
      </fieldset>
    ) : null

  if (gridMode(draft, encoding) || encoding === 'binary') {
    const isFile = (k: string) => encoding === 'binary' || files.includes(k.replace(/\[\d+\]/g, ''))
    const set = (fields: FieldRow[]) => onChange({ ...draft, fields })
    const fileKeys = (draft.fields.length ? draft.fields.map((r) => r.key) : []).filter(isFile)
    return (
      <>
        {viewToggle && (
          <div class="section-head">
            <h3>Body</h3>
            <span class="chip">{encoding}</span>
            <span class="spacer" />
            {viewToggle}
          </div>
        )}
        <ParamGrid
          title={encoding === 'binary' ? 'File' : 'Body'}
          bare={!!viewToggle}
          rows={draft.fields}
          readOnly={readOnly}
          onChange={set}
          documented={[...new Set(fileKeys)].map((name) => ({ name, file: true }))}
          docFor={(k) => fieldDoc(schema, defs, keyPath(k), ['data'])}
        />
      </>
    )
  }

  const format = () => {
    try {
      onChange({ ...draft, body: JSON.stringify(JSON.parse(draft.body), null, 2) })
    } catch {
      /* the invalid-JSON message is shown by the panel */
    }
  }

  if (encoding === 'graphql' && splitGraphql(draft.body))
    return <GraphqlBody draft={draft} onChange={onChange} readOnly={readOnly} />

  return (
    <section class="body" aria-label="Body">
      <div class="section-head">
        <h3>Body</h3>
        <span class="chip">{encoding}</span>
        <span class="spacer" />
        {encoding !== 'text' && !readOnly && (
          <button type="button" class="link" onClick={format}>
            Format
          </button>
        )}
        {viewToggle}
      </div>
      <BodyEditor
        readOnly={readOnly}
        label="Request body"
        language={language(encoding === 'form' ? 'json' : encoding)}
        value={draft.body}
        onChange={(body) => onChange({ ...draft, body })}
        onLine={setLine}
        complete={complete}
      />
      {documented && <FieldDoc doc={doc} />}
    </section>
  )
}
