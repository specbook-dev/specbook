import { type AuthProfile, acceptedProfiles } from '@specbook/core/internal'
import { useEffect, useState } from 'preact/hooks'
import { describeSecurity } from '../auth-describe'
import { authOptions } from '../auth-options'
import type { Variant } from '../engine'
import { markdownToHtml } from '../markdown'
import { engine, registry } from '../runtime'
import type { Defs, JsonSchema } from '../schema'
import { typeInfo, unwrap } from '../schema'
import { statusClass, statusName } from '../status'
import { version } from '../store'
import { FieldTable } from './FieldTable'
import type { BlockName, Segment } from './includes'
import { useOperationPage } from './page'

export interface DocOp {
  id: string
  method: string
  path: string
  summary?: string
  tags: string[]
  statuses: number[]
  mockVariants?: Record<string, { name: string; title?: string }[]>
  /** the spec requires credentials */
  secured?: boolean
  /** any one of these is enough; every scheme in one entry applies together, with the scopes it needs */
  security?: Record<string, string[]>[]
}

interface ResponseDoc {
  description?: string
  contentType?: string
}

interface LongDocs {
  description?: string
  examples: { name: string; title: string; source: string }[]
  /** what each status is, by code */
  responses?: Record<string, ResponseDoc>
}

const SECTIONS = [
  ['path', 'Path'],
  ['query', 'Query'],
  ['headers', 'Headers'],
] as const

/** Everything the page shows below its header, fetched together so the page is laid out once. */
interface Loaded {
  long?: LongDocs
  req?: JsonSchema
  /** the schema of each status's body, by code */
  resp?: Record<string, JsonSchema>
  defs?: Defs
  /** a saved request's own markdown (`<name>.req.md` beside its `.req.ts`), by file */
  saved: Record<string, string>
}

const soft = <T,>(p: Promise<T> | undefined): Promise<T | undefined> =>
  (p ?? Promise.resolve(undefined)).catch(() => undefined)

function loadAll(key: string, service: string, files: string[]): Promise<Loaded> {
  return Promise.all([
    soft(registry.operationDocs[key]?.().then((m: { default: LongDocs }) => m.default)),
    soft(registry.schemas[key]?.().then((m: { default: JsonSchema }) => m.default)),
    soft(
      registry.responseSchemas[key]?.().then(
        (m: { default: Record<string, JsonSchema> }) => m.default,
      ),
    ),
    soft(registry.definitions[service]?.().then((m: { default: Defs }) => m.default)),
    Promise.all(files.map((f) => soft(registry.docs.find((d) => d.requestFile === f)?.load()))),
  ]).then(([long, req, resp, defs, notes]) => ({
    long,
    req,
    resp,
    defs,
    saved: Object.fromEntries(files.flatMap((f, i) => (notes[i] ? [[f, notes[i] as string]] : []))),
  }))
}

/** A saved request's own markdown (`<name>.req.md` beside its `.req.ts`), when it has one. */
function SavedRequestNote({ variant, html }: { variant: Variant; html?: string }) {
  if (!html) return null
  return (
    <section class="saved-note-doc">
      <h2>
        Request <code>{variant.name}</code>
      </h2>
      <div class="doc-custom" dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  )
}

/** What a body is, in a line: its type, and the media type it is written in when the spec says. */
function BodyType({
  schema,
  defs,
  contentType,
}: {
  schema?: JsonSchema
  defs?: Defs
  contentType?: string
}) {
  const info = schema ? typeInfo(schema, defs) : undefined
  return (
    <p class="body-type">
      {info ? (
        <>
          <span class="chip" title={info.title}>
            {info.text}
          </span>{' '}
        </>
      ) : (
        !contentType && <span class="muted">No body described</span>
      )}
      {contentType && <span class="muted">{contentType}</span>}
    </p>
  )
}

function ResponseSection({
  statuses,
  mockVariants,
  docs,
  schemas,
  defs,
}: {
  statuses: number[]
  mockVariants?: DocOp['mockVariants']
  docs?: Record<string, ResponseDoc>
  schemas?: Record<string, JsonSchema>
  defs?: Defs
}) {
  const [status, setStatus] = useState(
    () => statuses.find((s) => s >= 200 && s < 300) ?? (statuses[0] as number),
  )
  const doc = docs?.[String(status)]
  const schema = schemas?.[String(status)]
  const variants = mockVariants?.[String(status)]
  return (
    <section>
      <h2>Responses</h2>
      <div class="statuses status-tabs" role="tablist">
        {statuses.map((s) => (
          <button
            type="button"
            role="tab"
            aria-selected={s === status}
            class={`rq-tab ${s === status ? 'on' : ''}`}
            onClick={() => setStatus(s)}
          >
            <span class={`state-badge ${statusClass(s)}`}>{s}</span> {statusName(s)}
          </button>
        ))}
      </div>
      <div role="tabpanel" key={status}>
        {doc?.description && (
          <div
            class="doc-custom"
            dangerouslySetInnerHTML={{ __html: markdownToHtml(doc.description) }}
          />
        )}
        <BodyType schema={schema} defs={defs} contentType={doc?.contentType} />
        {variants && variants.length > 1 && (
          <p class="muted">Variants: {variants.map((v) => v.title ?? v.name).join(' · ')}</p>
        )}
        {schema && <FieldTable schema={schema} defs={defs} />}
      </div>
    </section>
  )
}

export function OperationDocs({
  service,
  op,
  variants = [],
  onTry,
}: {
  service: string
  op: DocOp
  variants?: Variant[]
  /** open the Try tab, optionally on a named example */
  onTry: (example?: string) => void
}) {
  const key = `${service}/${op.id}`
  const [loaded, setLoaded] = useState<Loaded>()
  const files = variants.map((v) => v.file)
  const fileKey = files.join('\n')

  useEffect(() => {
    let live = true
    setLoaded(undefined)
    loadAll(key, service, fileKey ? fileKey.split('\n') : []).then((l) => live && setLoaded(l))
    return () => {
      live = false
    }
  }, [key, service, fileKey])

  // the profiles of this project that work for the operation, in the order the service lists them
  const [works, setWorks] = useState<string[]>()
  useEffect(() => {
    let live = true
    engine.config(version.value).then((cfg) => {
      if (!live) return
      const options = authOptions(cfg, service)
      const names = acceptedProfiles(
        options.map((o) => o.name),
        cfg.auth as Record<string, AuthProfile | undefined>,
        op.security ?? (op.secured ? true : undefined),
      )
      setWorks(names.map((n) => options.find((o) => o.name === n)?.title ?? n))
    })
    return () => {
      live = false
    }
  }, [service, op.security, op.secured, version.value])
  const schemes = registry.manifests[service]?.securitySchemes
  const alternatives = describeSecurity(op.security, schemes)

  const page = useOperationPage(key)
  // the header is there at once; everything below it appears together once it has all arrived
  const ready = !!loaded && page.loaded
  const { long, req, resp, defs } = loaded ?? { saved: {} }
  const root = req ? unwrap(req, defs) : undefined
  const section = (name: string) => root?.properties?.[name] as JsonSchema | undefined
  const body = section('data')

  const description = long?.description && (
    <div
      class="doc-custom"
      dangerouslySetInnerHTML={{ __html: markdownToHtml(long.description) }}
    />
  )
  const auth =
    alternatives.length > 0 || (schemes && !op.secured) ? (
      <section class="doc-auth">
        <h2>Authorization</h2>
        {alternatives.length === 0 ? (
          <p>No credentials needed.</p>
        ) : (
          <>
            <p>{alternatives.length > 1 ? 'Send one of:' : 'Send:'}</p>
            <ul class="auth-list">
              {alternatives.map((parts) => (
                <li>
                  {parts.map((p, i) => (
                    <>
                      {i > 0 && ' and '}
                      <code>{p.scheme}</code> <span class="muted">{p.how}</span>
                      {p.scopes.length > 0 && (
                        <>
                          {' '}
                          with scopes <code>{p.scopes.join(', ')}</code>
                        </>
                      )}
                    </>
                  ))}
                </li>
              ))}
            </ul>
            {works && works.length > 0 && <p class="muted">In this project: {works.join(', ')}.</p>}
          </>
        )}
      </section>
    ) : null
  const saved = variants.map((v) => (
    <SavedRequestNote key={v.file} variant={v} html={loaded?.saved[v.file]} />
  ))
  const params = (k: 'path' | 'query' | 'headers') => {
    const schema = section(k)
    return schema ? (
      <section>
        <h2>{SECTIONS.find(([n]) => n === k)?.[1]} parameters</h2>
        <FieldTable schema={schema} defs={defs} />
      </section>
    ) : null
  }
  const requestBody = body && (
    <section>
      <h2>Request body</h2>
      <BodyType schema={body} defs={defs} />
      <FieldTable schema={body} defs={defs} />
    </section>
  )
  const responses = op.statuses.length > 0 && (
    <ResponseSection
      statuses={op.statuses}
      mockVariants={op.mockVariants}
      docs={long?.responses}
      schemas={resp}
      defs={defs}
    />
  )
  const examples = (long?.examples.length ?? 0) > 1 && (
    <section>
      <h2>Examples</h2>
      <ul class="examples">
        {long?.examples.map((e) => (
          <li>
            <button type="button" class="link" onClick={() => onTry(e.name)}>
              ▶ {e.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
  const blocks: Record<BlockName, unknown> = {
    description,
    auth,
    path: params('path'),
    query: params('query'),
    headers: params('headers'),
    params: [params('path'), params('query'), params('headers')],
    body: requestBody,
    responses,
    examples,
  }

  // the blocks the page puts where it wants them; the rest follow it in the usual order
  const placed = new Set<BlockName>()
  for (const seg of page.segments) if ('block' in seg) placed.add(seg.block)
  if (placed.has('params')) for (const k of ['path', 'query', 'headers'] as const) placed.add(k)
  const show = (name: BlockName) => (placed.has(name) ? null : blocks[name])

  const segment = (seg: Segment) =>
    'block' in seg ? (
      (blocks[seg.block] as preact.ComponentChild)
    ) : (
      <div
        class={`doc-custom ${page.replace ? '' : 'doc-project'}`}
        dangerouslySetInnerHTML={{ __html: seg.html }}
      />
    )

  return (
    <article class="doc" data-op={key}>
      <div class="doc-intro">
        <span class={`method ${op.method}`}>{op.method}</span> <code>{op.path}</code>
        <span class="spacer" />
        <button type="button" class="btn primary" onClick={() => onTry()}>
          Try it
        </button>
      </div>

      {ready && (
        <>
          {/* the spec's own text first; the project's page follows it, or stands in for it with `replace: true` */}
          {!(page.found && page.replace) && show('description')}
          {page.segments.map(segment)}
          {show('auth')}
          {saved}
          {show('path')}
          {show('query')}
          {show('headers')}
          {show('body')}
          {show('responses')}
          {show('examples')}
        </>
      )}
    </article>
  )
}
