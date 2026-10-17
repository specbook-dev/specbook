import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { brand } from '../branding'
import { catalogFilter, catalogService, type Entry, go, route, search } from '../nav'
import { Lock } from '../panel/icons'
import { isMinimal } from '../runtime'
import { ModeHint } from './ModeHint'
import { PoweredBy } from './PoweredBy'

export interface ServiceInfo {
  id: string
  title?: string
  version?: string
  ops: number
}

/** Groups with more operations than this start collapsed unless something is being searched. */
const OPEN_LIMIT = 60

const DEFAULT_FLOW_GROUP = 'Default'

function isActive(e: Entry): boolean {
  const r = route.value
  if (e.route.kind === 'op' && r.kind === 'op' && e.route.key === r.key) {
    // a saved request is active on its own link; the operation row stays quiet while one of its requests is open
    const onSaved = (r.play ?? '').startsWith('saved:')
    return e.kind === 'req' ? r.play === e.route.play : !onSaved
  }
  return e.route.kind === 'seq' && r.kind === 'seq' && e.route.id === r.id
}

function OpRow({ e }: { e: Entry }) {
  return (
    <button
      type="button"
      class={`op-row ${isActive(e) ? 'active' : ''}`}
      onClick={() => go(e.route)}
      title={e.path ? `${e.title}\n${e.path}` : e.title}
    >
      <span class={`method ${e.method}`}>{e.method}</span>
      <span class="op-title">
        {e.title}
        {e.secured && (
          <span class="op-lock" title="Needs credentials">
            <Lock />
          </span>
        )}
      </span>
      <span class="op-path">{e.path}</span>
    </button>
  )
}

/** Shared by the list and the overview: which entries the current pill and filter select. */
function useCatalog(entries: Entry[], services: ServiceInfo[]) {
  const q = catalogFilter.value.trim()
  const single = services.length <= 1
  const svc = single ? (services[0]?.id ?? '') : catalogService.value
  const ops = useMemo(() => entries.filter((e) => e.kind === 'op'), [entries])
  const flows = useMemo(() => entries.filter((e) => e.kind === 'seq'), [entries])
  const reqs = useMemo(() => entries.filter((e) => e.kind === 'req'), [entries])
  const shownReqs = useMemo(() => {
    const scoped = svc ? reqs.filter((e) => e.service === svc) : reqs
    return q ? search(scoped, q, 200) : scoped
  }, [reqs, svc, q])
  const shownOps = useMemo(() => {
    const scoped = svc ? ops.filter((e) => e.service === svc) : ops
    return q ? search(scoped, q, 500) : scoped
  }, [ops, svc, q])
  const shownFlows = useMemo(() => {
    const scoped = svc && !single ? flows.filter((e) => e.tags?.includes(svc)) : flows
    return q ? search(scoped, q, 100) : scoped
  }, [flows, svc, q, single])
  return { q, single, svc, shownOps, shownFlows, shownReqs }
}

/** The left column: pills, filter and grouped rows. It never changes width, so opening the panel moves nothing. */
export function CatalogList({ entries, services }: { entries: Entry[]; services: ServiceInfo[] }) {
  const filter = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // what the user chose per group; groups they haven't touched follow the default
  const [chosen, setChosen] = useState<Map<string, boolean>>(new Map())
  const { q, single, svc, shownOps, shownFlows, shownReqs } = useCatalog(entries, services)
  // the flows and the requests are each a section that folds, open until the person closes it
  const sectionOpen = (name: string) => chosen.get(`section:${name}`) ?? true
  const toggleSection = (name: string) => {
    const n = new Map(chosen)
    n.set(`section:${name}`, !sectionOpen(name))
    setChosen(n)
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
        e.preventDefault()
        filter.current?.focus()
      }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [])

  // arrow keys walk the rows; going up from the first one returns to the filter
  useEffect(() => {
    const el = list.current
    if (!el) return
    const move = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const rows = [...el.querySelectorAll<HTMLElement>('.op-row, .flow-row')]
      const at = rows.indexOf(document.activeElement as HTMLElement)
      if (at < 0) return
      const next = e.key === 'ArrowDown' ? at + 1 : at - 1
      e.preventDefault()
      if (next >= 0 && next < rows.length) rows[next]?.focus()
      else if (next < 0) filter.current?.focus()
    }
    el.addEventListener('keydown', move)
    return () => el.removeEventListener('keydown', move)
  }, [])

  const groups = useMemo(() => {
    const m = new Map<string, Entry[]>()
    for (const e of shownOps) {
      const tag = e.tag ?? 'default'
      const name = svc || single ? tag : `${e.service} · ${tag}`
      m.set(name, [...(m.get(name) ?? []), e])
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [shownOps, svc, single])

  // "Default" first, then the rest alphabetically
  const flowGroups = useMemo(() => {
    const m = new Map<string, Entry[]>()
    for (const e of shownFlows) {
      const name = e.flowGroup?.trim() || DEFAULT_FLOW_GROUP
      m.set(name, [...(m.get(name) ?? []), e])
    }
    const rank = (n: string) => (n === DEFAULT_FLOW_GROUP ? 0 : 1)
    return [...m.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
  }, [shownFlows])

  const crowded = shownOps.length > OPEN_LIMIT && !q
  const isOpen = (name: string, rows: Entry[]) =>
    chosen.get(name) ?? (!crowded || rows.some(isActive))
  const toggle = (name: string, rows: Entry[]) => {
    const n = new Map(chosen)
    n.set(name, !isOpen(name, rows))
    setChosen(n)
  }

  return (
    <div class="catalog" ref={list}>
      <div class="cat-top">
        {!single && (
          <div class="pills" role="tablist" aria-label="APIs">
            <button
              type="button"
              role="tab"
              aria-selected={svc === ''}
              class={`pill ${svc === '' ? 'on' : ''}`}
              onClick={() => (catalogService.value = '')}
            >
              All
            </button>
            {services.map((s) => (
              <button
                type="button"
                role="tab"
                aria-selected={svc === s.id}
                class={`pill ${svc === s.id ? 'on' : ''}`}
                onClick={() => (catalogService.value = s.id)}
              >
                {s.id} <span class="count">{s.ops}</span>
              </button>
            ))}
          </div>
        )}
        <div class="cat-filter-wrap">
          <input
            ref={filter}
            type="text"
            class="cat-filter"
            placeholder={
              svc
                ? `Filter ${svc}`
                : isMinimal
                  ? 'Filter requests and flows'
                  : 'Filter operations and flows'
            }
            aria-label="Filter"
            value={catalogFilter.value}
            onInput={(e) => (catalogFilter.value = (e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                list.current?.querySelector<HTMLElement>('.op-row, .flow-row')?.focus()
              }
              if (e.key === 'Escape') catalogFilter.value = ''
            }}
          />
          <kbd class="cat-hint" title="Focus the filter">
            /
          </kbd>
        </div>
      </div>

      {flowGroups.length > 0 && (
        <section class="flows" aria-label="Flows">
          <button
            type="button"
            class="flows-title"
            aria-expanded={sectionOpen('flows')}
            onClick={() => toggleSection('flows')}
          >
            <span class="caret">{sectionOpen('flows') ? '▾' : '▸'}</span>
            <span class="method flow">FLOW</span>
            <span class="muted small">Multi-step flows you can run end to end</span>
            <span class="count">{shownFlows.length}</span>
          </button>
          {sectionOpen('flows') &&
            flowGroups.map(([name, rows]) => {
              const key = `flows:${name}`
              const solo = flowGroups.length === 1
              const expanded = solo || (chosen.get(key) ?? true)
              return (
                <div class="flow-group" key={key}>
                  {!solo && (
                    <button
                      type="button"
                      class="group-head flow-head"
                      aria-expanded={expanded}
                      onClick={() => {
                        const n = new Map(chosen)
                        n.set(key, !expanded)
                        setChosen(n)
                      }}
                    >
                      <span class="caret">{expanded ? '▾' : '▸'}</span> {name}{' '}
                      <span class="count">{rows.length}</span>
                    </button>
                  )}
                  {expanded &&
                    rows.map((e) => (
                      <button
                        type="button"
                        class={`op-row flow-row ${isActive(e) ? 'active' : ''}`}
                        onClick={() => go(e.route)}
                      >
                        <span class="flow-play" aria-hidden="true">
                          ▶
                        </span>
                        <span class="op-title">{e.title}</span>
                      </button>
                    ))}
                </div>
              )
            })}
        </section>
      )}

      {shownReqs.length > 0 && (
        <section class="flows requests" aria-label="Requests">
          <button
            type="button"
            class="flows-title"
            aria-expanded={sectionOpen('requests')}
            onClick={() => toggleSection('requests')}
          >
            <span class="caret">{sectionOpen('requests') ? '▾' : '▸'}</span>
            <span class="method req">REQ</span>
            <span class="muted small">Requests you can run and check</span>
            <span class="count">{shownReqs.length}</span>
          </button>
          {sectionOpen('requests') &&
            shownReqs.map((e) => (
              <button
                type="button"
                class={`op-row req-row ${isActive(e) ? 'active' : ''}`}
                onClick={() => go(e.route)}
                title={`${e.method} ${e.path}`}
              >
                <span class={`method ${e.method}`}>{e.method}</span>
                <span class="op-title">
                  {e.title}
                  {(e.tags ?? []).map((t) => (
                    <span class="chip req-tag">{t}</span>
                  ))}
                </span>
                <span class="op-path">{e.path}</span>
              </button>
            ))}
        </section>
      )}

      {groups.map(([name, rows]) => {
        const expanded = isOpen(name, rows)
        return (
          <div class="op-group" key={name}>
            <button
              type="button"
              class="group-head"
              aria-expanded={expanded}
              onClick={() => toggle(name, rows)}
            >
              <span class="caret">{expanded ? '▾' : '▸'}</span> {name}{' '}
              <span class="count">{rows.length}</span>
            </button>
            {expanded && rows.map((e) => <OpRow e={e} />)}
          </div>
        )
      })}
      {groups.length === 0 && flowGroups.length === 0 && shownReqs.length === 0 && (
        <p class="muted cat-empty">
          {q ? `Nothing matches “${q}”.` : 'No operations.'}{' '}
          {q && (
            <button type="button" class="link" onClick={() => (catalogFilter.value = '')}>
              Clear the filter
            </button>
          )}
        </p>
      )}
    </div>
  )
}

/** The stage when nothing is open: the API's identity, since the list is the content. */
export function Overview({
  services,
  counts,
}: {
  services: ServiceInfo[]
  counts?: { flows: number; requests: number }
}) {
  const b = brand.value
  // wait for the project's branding: showing the fallback first and swapping it makes the page jump
  if (!b.ready) return <div class="overview" aria-busy="true" />
  const total = services.reduce((n, s) => n + s.ops, 0)
  const single = services.length === 1 ? services[0] : undefined
  const title =
    b.title ??
    b.name ??
    (single
      ? (single.title ?? single.id)
      : `${services.length} APIs · ${total.toLocaleString()} operations`)
  const worth = (n: number, one: string, many: string) =>
    `${n.toLocaleString()} ${n === 1 ? one : many}`
  const meta =
    isMinimal && counts
      ? `${worth(counts.flows, 'flow', 'flows')} · ${worth(counts.requests, 'request', 'requests')}`
      : single
        ? `${single.ops} ${single.ops === 1 ? 'operation' : 'operations'}${single.version ? ` · v${single.version}` : ''}`
        : b.name || b.title
          ? `${services.length} APIs · ${total.toLocaleString()} operations`
          : undefined
  return (
    <div class="overview">
      {b.logo && (
        <img
          class="overview-logo"
          src={b.logo}
          alt=""
          style={
            b.logoBackground
              ? { background: b.logoBackground, padding: '10px 16px', borderRadius: '10px' }
              : undefined
          }
        />
      )}
      {b.title && b.name && <p class="overview-name">{b.name}</p>}
      <h1>{title}</h1>
      {b.tagline && <p class="tagline">{b.tagline}</p>}
      {meta && <p class="muted">{meta}</p>}
      <p class="overview-hint">
        {isMinimal
          ? 'Choose a request or flow on the left to run it.'
          : 'Choose an operation or flow on the left to read it and try it.'}
      </p>
      <ModeHint />
      <button
        type="button"
        class="btn primary overview-browse"
        onClick={() => go({ kind: 'browse' })}
      >
        {isMinimal ? 'Browse requests and flows' : 'Browse operations and flows'}
      </button>
      {b.links.length > 0 && (
        <p class="overview-links">
          {b.links.map((l) => (
            <a href={l.href} target="_blank" rel="noreferrer">
              {l.label}
            </a>
          ))}
        </p>
      )}
      <p class="muted overview-keys">
        <kbd>⌘</kbd> <kbd>K</kbd> jumps anywhere · <kbd>/</kbd> filters the list
      </p>
      <PoweredBy />
    </div>
  )
}
