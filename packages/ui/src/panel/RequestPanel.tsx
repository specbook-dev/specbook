import { collectPlaceholders, type Encoding, type Example, type RunResult } from '@specbook/core'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { EnvBadge } from '../components/EnvBadge'
import type { Variant } from '../engine'
import { fieldDoc, withNote } from '../fielddoc'
import { engine, isStatic, registry, saveFile } from '../runtime'
import { type Defs, type JsonSchema, propsOf, unwrap } from '../schema'
import { statusClass, statusName } from '../status'
import { kv } from '../storage'
import { env, envSettingsOpen, envVarsVersion, features, locale, seed, version } from '../store'
import { announcement, describeRun } from './announce'
import { Body } from './Body'
import { DraftCodeSample } from './CodeSample'
import { type Draft, draftFrom, forStorage, previewUrl, requestParts } from './draft'
import { useOperationNotes } from './fieldnotes'
import { PaperPlane } from './icons'
import { type Documented, ParamGrid } from './ParamGrid'
import { RequestView } from './RequestView'
import { ResponseView } from './ResponseView'
import { SecretsBar } from './SecretsBar'
import { useRequestNote } from './stepnotes'

export interface OpInfo {
  id: string
  method: string
  path: string
  summary?: string
  tags: string[]
  statuses: number[]
}

interface Props {
  service: string
  op: OpInfo
  variants: Variant[]
  /** example name to open, '' for the first */
  initial: string
  /** run once as soon as the request is ready (an embed that asks for it, never against production) */
  autoRun?: boolean
}

const storeKey = (key: string, sel: string) => `specbook:draft:${key}:${sel}`
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

function readDraft(key: string): Draft | undefined {
  try {
    const raw = kv.local.getItem(key)
    return raw ? (JSON.parse(raw) as Draft) : undefined
  } catch {
    return undefined
  }
}

/**
 * A saved example arrives through the file watcher, which reloads the page; this carries the
 * confirmation (and the selection) across that reload.
 */
const SAVED_KEY = 'specbook:saved-example'
interface SavedExample {
  key: string
  path: string
  name: string
}

function takeSaved(key: string): SavedExample | undefined {
  try {
    const raw = kv.session.getItem(SAVED_KEY)
    const saved = raw ? (JSON.parse(raw) as SavedExample) : undefined
    if (saved?.key !== key) return undefined
    kv.session.removeItem(SAVED_KEY)
    return saved
  } catch {
    return undefined
  }
}

export function RequestPanel({ service, op, variants, initial, autoRun }: Props) {
  const key = `${service}/${op.id}`
  const panelRoot = useRef<HTMLDivElement>(null)
  const autoRan = useRef(false)
  const examples = engine.examplesOf(key)
  const [notice, setNotice] = useState<SavedExample | undefined>(() => takeSaved(key))
  const [sel, setSel] = useState(() => {
    // a link to a saved request ("saved:<file>") opens on it
    if (initial?.startsWith('saved:') && variants.some((v) => `saved:${v.file}` === initial))
      return initial
    const named = examples.find((e) => e.name === (notice?.name ?? initial))
    return named
      ? `ex:${named.name}`
      : examples[0]
        ? `ex:${examples[0].name}`
        : variants[0]
          ? `saved:${variants[0].file}`
          : ''
  })
  const saved = sel.startsWith('saved:')
    ? variants.find((v) => `saved:${v.file}` === sel)
    : undefined

  const requestNote = useRequestNote(saved?.file)
  const opNotes = useOperationNotes(key)
  const [meta, setMeta] = useState<{ encoding: Encoding; files: string[] }>()
  const [base, setBase] = useState<Example>()
  const [draft, setDraft] = useState<Draft>()
  const [vars, setVars] = useState<Record<string, string>>({})
  const [reqSchema, setReqSchema] = useState<JsonSchema>()
  const [respSchemas, setRespSchemas] = useState<Record<string, JsonSchema>>()
  const [defs, setDefs] = useState<Defs>()
  const [forced, setForced] = useState<number>()
  const [result, setResult] = useState<RunResult>()
  const [error, setError] = useState<string>()
  const [running, setRunning] = useState(false)
  const [naming, setNaming] = useState<string>()
  const [tab, setTab] = useState<'params' | 'headers' | 'body' | 'vars' | 'request' | 'response'>()
  const [baseUrl, setBaseUrl] = useState('')
  const [known, setKnown] = useState<string[]>()

  const [addressError, setAddressError] = useState<string>()
  useEffect(() => {
    let on = true
    setAddressError(undefined)
    // mock has no address; elsewhere it is whatever this environment's variables make it
    if (env.value === 'mock') {
      setBaseUrl('')
      return
    }
    engine
      .baseUrlOf(service, env.value, version.value)
      .then((url) => on && setBaseUrl(url ?? ''))
      .catch((e: unknown) => {
        if (!on) return
        setBaseUrl('')
        setAddressError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      on = false
    }
  }, [service, env.value, version.value, envVarsVersion.value])

  useEffect(() => {
    let live = true
    setKnown(undefined)
    engine.knownVars(env.value, version.value).then((k) => live && setKnown(k))
    return () => {
      live = false
    }
  }, [env.value])

  useEffect(() => {
    let live = true
    registry.schemas[key]?.().then((m: { default: JsonSchema }) => live && setReqSchema(m.default))
    registry.responseSchemas[key]?.().then(
      (m: { default: Record<string, JsonSchema> }) => live && setRespSchemas(m.default),
    )
    registry.definitions[service]?.().then((m: { default: Defs }) => live && setDefs(m.default))
    engine.operationMeta(key, version.value).then((m) => {
      if (live) setMeta({ encoding: m?.encoding ?? 'json', files: m?.files ?? [] })
    })
    return () => {
      live = false
    }
  }, [key, service])

  const encoding = meta?.encoding ?? 'json'
  const secured = registry.manifests[service]?.operations.find((o) => o.id === op.id)?.secured

  useEffect(() => {
    if (!meta) return
    let live = true
    setError(undefined)
    setResult(undefined)
    ;(async () => {
      const ex = saved
        ? await engine.savedExample(saved.def, version.value)
        : await engine.loadExample(key, sel.replace(/^ex:/, ''), version.value)
      if (!live) return
      const fresh = ex ?? { name: 'empty', source: 'generated' as const }
      setBase(fresh)
      setDraft((!saved && readDraft(storeKey(key, sel))) || draftFrom(fresh, encoding))
    })().catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [key, sel, meta, saved])

  const baseDraft = useMemo(() => (base ? draftFrom(base, encoding) : undefined), [base, encoding])
  const modified =
    !!draft &&
    !!baseDraft &&
    JSON.stringify(forStorage(draft)) !== JSON.stringify(forStorage(baseDraft))

  const edit = (d: Draft) => {
    setDraft(d)
    if (saved) return
    try {
      const k = storeKey(key, sel)
      if (baseDraft && JSON.stringify(forStorage(d)) === JSON.stringify(forStorage(baseDraft)))
        kv.local.removeItem(k)
      else kv.local.setItem(k, JSON.stringify(forStorage(d)))
    } catch {
      /* optional */
    }
  }

  const sections = useMemo(() => {
    const root = reqSchema ? unwrap(reqSchema, defs) : undefined
    const out: Record<'path' | 'query' | 'headers', Documented[]> = {
      path: [],
      query: [],
      headers: [],
    }
    for (const s of ['path', 'query', 'headers'] as const) {
      const sec = root?.properties?.[s]
      if (!sec) continue
      out[s] = propsOf(sec, defs).map((p) => ({
        name: p.name,
        doc: withNote(fieldDoc(reqSchema, defs, [p.name], [s]), opNotes.notes, s, p.name),
        repeat: unwrap(p.schema, defs).type === 'array',
      }))
    }
    return out
  }, [reqSchema, defs, opNotes.notes])

  const placeholders = useMemo(() => {
    if (!draft) return []
    try {
      const parts = requestParts(draft, encoding)
      return [...collectPlaceholders([parts.path, parts.query, parts.headers, parts.data])]
        .filter(
          (n) => !n.startsWith('faker.') && !n.startsWith('secrets.') && !n.startsWith('session.'),
        )
        .map((n) => n.split('.')[0] as string)
        .filter((n, i, a) => a.indexOf(n) === i)
    } catch {
      return []
    }
  }, [draft, encoding])

  // placeholders nothing supplies: not in config or the environment's files. They stay listed while
  // you type, so the field you are filling does not disappear under you.
  const needed = known ? placeholders.filter((n) => !known.includes(n)) : []
  const unfilled = needed.filter((n) => (vars[n] ?? '') === '')

  const play = async (forceStatus?: number) => {
    if (!draft) return
    setError(undefined)
    setRunning(true)
    try {
      const def = saved
        ? saved.def
        : await engine.operationRequest(key, version.value, requestParts(draft, encoding))
      const ran = await engine.run(def, {
        env: env.value,
        version: version.value,
        mockStatus: env.value === 'mock' ? (forceStatus ?? forced) : undefined,
        locale: locale.value,
        seed: seed.value,
        vars: Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== '')),
        fileDir: base?.dir,
      })
      setResult(ran)
      announcement.value = describeRun(ran)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      // what you sent a request to see is the response, so show it (the tab stays one click away)
      setTab('response')
    }
  }

  useEffect(() => {
    if (!autoRun || !draft || autoRan.current) return
    autoRan.current = true
    void play()
  }, [draft])

  const saveExample = async (name: string) => {
    if (!draft) return
    const parts = requestParts(draft, encoding)
    const file = slug(name)
    const doc: Example = {
      name: file,
      title: name,
      source: 'project',
      path: parts.path,
      query: parts.query,
      headers: parts.headers,
      body: typeof parts.data === 'object' && parts.data instanceof Blob ? undefined : parts.data,
    }
    const path = `${registry.project.requestsDir}/${service}/${op.id}/${file}.example.json`
    // set before writing: the watcher reloads the page as soon as the file lands
    const saved: SavedExample = { key, path, name: file }
    try {
      kv.session.setItem(SAVED_KEY, JSON.stringify(saved))
    } catch {
      /* the confirmation below still shows when there is no reload */
    }
    await saveFile(path, `${JSON.stringify(doc, null, 2)}\n`)
    setNotice(saved)
    setNaming(undefined)
  }

  const step = result?.steps.find((s) => s.response) ?? result?.steps[0]
  const missing = error?.match(/Missing variable "\{\{([^}.]+)/)?.[1]
  const hasParams =
    !!draft &&
    (draft.path.length > 0 ||
      draft.query.length > 0 ||
      sections.path.length > 0 ||
      sections.query.length > 0)
  const hasHeaders = !!draft && (draft.headers.length > 0 || sections.headers.length > 0)
  const hasBody =
    !!draft &&
    encoding !== 'none' &&
    (draft.body !== '' || draft.fields.length > 0 || !!reqSchema?.properties?.data)
  const active =
    tab ?? (hasParams ? 'params' : hasBody ? 'body' : hasHeaders ? 'headers' : 'params')
  const count = (rows: { enabled: boolean }[]) => rows.filter((r) => r.enabled).length
  const nQuery = draft ? count(draft.query) : 0
  const nPath = draft ? count(draft.path) : 0
  const url = draft ? previewUrl(op.path, draft.path, draft.query, baseUrl) : op.path

  useEffect(() => {
    const send = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        play()
      }
    }
    // on the page's own root (a shadow root in an embed), not the window, so a host page's keys are left alone
    const root: EventTarget = panelRoot.current?.getRootNode() ?? window
    root.addEventListener('keydown', send as EventListener)
    return () => root.removeEventListener('keydown', send as EventListener)
  })

  return (
    <div class="request-panel" data-op={key} ref={panelRoot}>
      <div class="rq">
        <div class="rq-bar">
          <span class={`method ${op.method}`}>{op.method}</span>
          <div class="rq-url" title={url}>
            <code>
              {url
                .split(/(\{\{[^}]*\}\}|\{[^}]+\})/)
                .map((part) => (/^\{/.test(part) ? <mark>{part}</mark> : part))}
            </code>
          </div>
          {(step?.response || error || step?.error) && (
            <button
              type="button"
              class={`result-chip ${step?.response ? statusClass(step.response.status) : 's5'}`}
              title="Open the response"
              onClick={() => setTab('response')}
            >
              {step?.response
                ? `${step.response.status} ${statusName(step.response.status)} · ${step.response.durationMs} ms`
                : 'Failed'}
            </button>
          )}
          <button
            type="button"
            class="btn primary send"
            title="Send (⌘/Ctrl + Enter)"
            aria-label="Send"
            disabled={running || !draft}
            onClick={() => play()}
          >
            {running ? '…' : <PaperPlane />}
          </button>
        </div>

        {addressError && (
          <p class="envmenu-warn" role="alert">
            {addressError}.{' '}
            {features.value.environmentSettings && (
              <button type="button" class="link" onClick={() => (envSettingsOpen.value = true)}>
                Open Environment settings
              </button>
            )}
          </p>
        )}

        {requestNote && (
          <details class="step-about" key={saved?.file}>
            <summary>About this request</summary>
            <div class="doc-custom" dangerouslySetInnerHTML={{ __html: requestNote }} />
          </details>
        )}

        {needed.length > 0 && (
          <fieldset
            class={`needs-vars ${unfilled.length === 0 ? 'ok' : ''}`}
            aria-label="Values this request needs"
          >
            <span class="muted">{unfilled.length > 0 ? 'Needs a value for' : 'Values for'}</span>
            {needed.map((n) => (
              <label class="needs-var">
                <code>{n}</code>
                <input
                  type="text"
                  aria-label={n}
                  placeholder="value"
                  value={vars[n] ?? ''}
                  onInput={(e) => setVars({ ...vars, [n]: (e.target as HTMLInputElement).value })}
                />
              </label>
            ))}
          </fieldset>
        )}

        {secured && <SecretsBar services={[service]} />}

        <div class="rq-meta">
          <div class="rq-example">
            <label class="row">
              <span class="muted">Example</span>
              <select value={sel} onChange={(e) => setSel((e.target as HTMLSelectElement).value)}>
                {examples.map((e) => (
                  <option value={`ex:${e.name}`}>
                    {e.name}
                    {e.source === 'project' ? ' · yours' : ''}
                  </option>
                ))}
                {variants.map((v) => (
                  <option value={`saved:${v.file}`}>{v.name} · saved request</option>
                ))}
              </select>
            </label>
            <EnvBadge />
          </div>
          {modified && <span class="edited">Edited</span>}
          <span class="spacer" />
          {modified && (
            <button type="button" class="link" onClick={() => baseDraft && edit(baseDraft)}>
              ↺ Reset
            </button>
          )}
          {!isStatic && !saved && modified && naming === undefined && (
            <button type="button" class="link" onClick={() => setNaming('')}>
              Save as example…
            </button>
          )}
          {env.value === 'mock' && op.statuses.length > 0 && (
            <label class="rq-status">
              <span class="muted">Respond with</span>
              <select
                aria-label="Mock response"
                value={forced === undefined ? '' : String(forced)}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value
                  const s = v === '' ? undefined : Number(v)
                  setForced(s)
                  play(s)
                }}
              >
                <option value="">Default</option>
                {op.statuses.map((s) => (
                  <option value={String(s)}>
                    {s} {statusName(s)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {notice && (
          <p class="saved-note" role="status">
            <span>
              ✓ Saved to <code>{notice.path}</code>. It is a normal project file: commit it to share
              this example with your team.
            </span>
            <button
              type="button"
              class="icon"
              aria-label="Dismiss"
              onClick={() => setNotice(undefined)}
            >
              ×
            </button>
          </p>
        )}

        {naming !== undefined && (
          <form
            class="row naming"
            onSubmit={(e) => {
              e.preventDefault()
              if (naming.trim()) saveExample(naming.trim()).catch((err) => setError(String(err)))
            }}
          >
            <input
              autofocus
              placeholder="Name this example"
              aria-label="Example name"
              value={naming}
              onInput={(e) => setNaming((e.target as HTMLInputElement).value)}
            />
            <button type="submit" class="btn">
              Save
            </button>
            <button type="button" class="link" onClick={() => setNaming(undefined)}>
              Cancel
            </button>
          </form>
        )}

        {saved && (
          <p class="muted lock">
            A saved request: its own values, checks and mock responses apply, and it is read-only
            here.
          </p>
        )}

        <div class="rq-tabs" role="tablist">
          {(
            [
              ['params', 'Params', nQuery + nPath],
              ['headers', 'Headers', draft ? count(draft.headers) : 0],
              ['body', 'Body', 0],
              ['vars', 'Variables', placeholders.length],
            ] as const
          )
            .filter(([id]) =>
              id === 'params'
                ? hasParams
                : id === 'headers'
                  ? hasHeaders
                  : id === 'body'
                    ? hasBody
                    : placeholders.length > 0,
            )
            .map(([id, label, n]) => (
              <button
                type="button"
                role="tab"
                aria-selected={active === id}
                class={`rq-tab ${active === id ? 'on' : ''}`}
                onClick={() => setTab(id)}
              >
                {label}
                {n > 0 && <span class="count">{n}</span>}
                {id === 'body' && <span class="chip">{encoding}</span>}
              </button>
            ))}
          <span class="tab-gap" />
          <button
            type="button"
            role="tab"
            aria-selected={active === 'request'}
            class={`rq-tab ${active === 'request' ? 'on' : ''}`}
            onClick={() => setTab('request')}
          >
            Request
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={active === 'response'}
            class={`rq-tab ${active === 'response' ? 'on' : ''}`}
            onClick={() => setTab('response')}
          >
            Response
            {step?.response && (
              <span class={`state-dot ${statusClass(step.response.status)}`}>
                {step.response.status}
              </span>
            )}
            {!step?.response && (error || step?.error) && <span class="state-dot s5">!</span>}
          </button>
        </div>

        <div class="rq-pane">
          {draft && (
            <>
              <div class="tab-pane" hidden={active !== 'params'}>
                {(draft.query.length > 0 || sections.query.length > 0) && (
                  <ParamGrid
                    title="Query"
                    rows={draft.query}
                    documented={sections.query}
                    readOnly={!!saved}
                    onChange={(query) => edit({ ...draft, query })}
                  />
                )}
                {(draft.path.length > 0 || sections.path.length > 0) && (
                  <ParamGrid
                    title="Path"
                    rows={draft.path}
                    documented={sections.path}
                    fixed
                    readOnly={!!saved}
                    onChange={(path) => edit({ ...draft, path })}
                  />
                )}
              </div>
              <div class="tab-pane" hidden={active !== 'headers'}>
                {hasHeaders && (
                  <ParamGrid
                    title="Headers"
                    rows={draft.headers}
                    documented={sections.headers}
                    readOnly={!!saved}
                    onChange={(headers) => edit({ ...draft, headers })}
                  />
                )}
              </div>
              <div class="tab-pane" hidden={active !== 'body'}>
                {hasBody && (
                  <Body
                    encoding={encoding}
                    draft={draft}
                    onChange={edit}
                    schema={reqSchema}
                    defs={defs}
                    files={meta?.files}
                    notes={opNotes.notes}
                    readOnly={!!saved}
                  />
                )}
              </div>
              <div class="tab-pane" hidden={active !== 'vars'}>
                {placeholders.length > 0 && (
                  <ParamGrid
                    title="Variables"
                    rows={placeholders.map((n) => ({
                      key: n,
                      value: vars[n] ?? '',
                      enabled: true,
                    }))}
                    fixed
                    bad={missing}
                    placeholder="from the request's init, config or earlier steps"
                    onChange={(rows) =>
                      setVars(Object.fromEntries(rows.map((r) => [r.key, r.value])))
                    }
                  />
                )}
              </div>
            </>
          )}
          <div class="tab-pane" hidden={active !== 'request'}>
            {draft && (
              <DraftCodeSample
                service={service}
                method={op.method}
                path={op.path}
                draft={draft}
                encoding={encoding}
                vars={vars}
                secured={secured}
                sent={
                  step?.request ? (
                    <RequestView
                      request={step.request}
                      docs={{ schema: reqSchema, defs, notes: opNotes.notes }}
                    />
                  ) : undefined
                }
              />
            )}
          </div>
          <div class="tab-pane" hidden={active !== 'response'}>
            <ResponseView step={step} error={error} schemas={respSchemas} defs={defs} />
          </div>
        </div>
      </div>
    </div>
  )
}
