import { useEffect, useState } from 'preact/hooks'
import type { Variant } from '../engine'
import { markdownToHtml } from '../markdown'
import { registry } from '../runtime'
import type { Defs, JsonSchema } from '../schema'
import { unwrap } from '../schema'
import { statusClass, statusName } from '../status'
import { FieldTable } from './FieldTable'
import { useOperationNotes } from './fieldnotes'

export interface DocOp {
  id: string
  method: string
  path: string
  summary?: string
  tags: string[]
  statuses: number[]
}

interface LongDocs {
  description?: string
  examples: { name: string; title: string; source: string }[]
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
    soft(registry.definitions[service]?.().then((m: { default: Defs }) => m.default)),
    Promise.all(files.map((f) => soft(registry.docs.find((d) => d.requestFile === f)?.load()))),
  ]).then(([long, req, defs, notes]) => ({
    long,
    req,
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
        Saved request <code>{variant.name}</code>
      </h2>
      <div class="doc-custom" dangerouslySetInnerHTML={{ __html: html }} />
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

  const page = useOperationNotes(key)
  // the header is there at once; everything below it appears together once it has all arrived
  const ready = !!loaded && page.loaded
  const { long, req, defs } = loaded ?? { saved: {} }
  const root = req ? unwrap(req, defs) : undefined
  const section = (name: string) => root?.properties?.[name] as JsonSchema | undefined
  const body = section('data')

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
          {!(page.found && page.replace) && long?.description && (
            <div
              class="doc-custom"
              dangerouslySetInnerHTML={{ __html: markdownToHtml(long.description) }}
            />
          )}
          {page.intro && (
            <div
              class={`doc-custom ${page.replace ? '' : 'doc-project'}`}
              dangerouslySetInnerHTML={{ __html: page.intro }}
            />
          )}

          {variants.map((v) => (
            <SavedRequestNote key={v.file} variant={v} html={loaded?.saved[v.file]} />
          ))}

          {SECTIONS.map(([k, title]) =>
            section(k) ? (
              <section>
                <h2>{title} parameters</h2>
                <FieldTable schema={section(k)} defs={defs} section={k} notes={page.notes} />
              </section>
            ) : null,
          )}

          {body && (
            <section>
              <h2>Request body</h2>
              <FieldTable schema={body} defs={defs} section="data" notes={page.notes} />
            </section>
          )}

          {op.statuses.length > 0 && (
            <section>
              <h2>Responses</h2>
              <ul class="statuses">
                {op.statuses.map((s) => (
                  <li>
                    <span class={`state-badge ${statusClass(s)}`}>{s}</span> {statusName(s)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(long?.examples.length ?? 0) > 1 && (
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
          )}
        </>
      )}
    </article>
  )
}
