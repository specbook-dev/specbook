import { signal } from '@preact/signals'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import markUrl from './assets/mark.svg'
import { applyBranding, brand } from './branding'
import { CatalogList, Overview, type ServiceInfo } from './components/Catalog'
import { EnvBadge } from './components/EnvBadge'
import { EnvironmentMenu } from './components/EnvironmentMenu'
import { GitHubStar } from './components/GitHubStar'
import { ListResizer, listWidth } from './components/ListResizer'
import { Palette } from './components/Palette'
import { ShareMenu } from './components/ShareMenu'
import { ThemeToggle } from './components/ThemeToggle'
import type { SequenceInfo, Variant } from './engine'
import { type Entry, go, pageOf, paletteOpen, parseHash, route, setDefaultService } from './nav'
import { engine, registry } from './runtime'
import { env, environmentRisk, environments, locale, seed, version } from './store'

// the hosted viewer is Specbook itself, so its header carries our mark unless the API brings a logo
const ownMark = globalThis.__SPECBOOK_VIEWER__?.source ? markUrl : undefined

// one API: its links leave the service out
{
  const names = Object.keys(registry.manifests)
  setDefaultService(names.length === 1 ? names[0] : undefined)
}

const fakerLocales = signal<string[]>([])

type HostModule = typeof import('./panel/Host')

/** The side panel is a separate chunk: it holds the editor and is only fetched on first Play. */
function usePanelHost() {
  const [host, setHost] = useState<HostModule>()
  const wanted = route.value.kind === 'op' || route.value.kind === 'seq'
  useEffect(() => {
    if (wanted && !host) import('./panel/Host').then(setHost)
  }, [wanted, host])
  return wanted ? host : undefined
}

export function App() {
  const [variants, setVariants] = useState<Record<string, Variant[]>>({})
  const [sequences, setSequences] = useState<SequenceInfo[] | undefined>(undefined)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const onHash = () => {
      route.value = parseHash(location.hash)
    }
    addEventListener('hashchange', onHash)
    // The project's config comes first: the overview waits for it. Saved requests and sequences are
    // only needed for search and the Try picker, so they load once the first screen can be drawn.
    const loadRest = () => {
      engine.loadVariants(registry.requests, version.value).then(setVariants)
      // Headers are read from the files' text; only ones that aren't plain literals are imported.
      const odd = registry.sequences.filter((e) => registry.unresolvedSequences.includes(e.file))
      if (odd.length) engine.loadSequences(odd, version.value).then(setSequences)
    }
    engine
      .config(version.value)
      .then(async (c) => {
        fakerLocales.value = Object.keys(c.faker?.locales ?? {})
        if (c.faker?.default) locale.value = c.faker.default
        const b = c.branding
        const assets = registry.brandingAssets
        const only = Object.values(registry.manifests)
        // with one API, the spec's own `info.x-logo` is the fallback after the project's files
        const spec = only.length === 1 ? only[0]?.logo : undefined
        const file = b?.logo ?? (await assets.logo?.().catch(() => undefined))
        const resolved = {
          ready: true,
          name: b?.name,
          title: b?.title,
          tagline: b?.tagline,
          links: b?.links ?? [],
          badge: b?.badge,
          logo: file ?? spec?.url,
          logoBackground: file ? undefined : spec?.backgroundColor,
          favicon: b?.favicon ?? (await assets.favicon?.().catch(() => undefined)),
        }
        brand.value = resolved
        applyBranding(b, resolved, only.length === 1 ? (only[0]?.title ?? 'Specbook') : 'Specbook')
      })
      .catch(() => {
        // a project without a readable config still gets its overview, from the APIs' own titles
        brand.value = { ...brand.value, ready: true }
      })
      .finally(loadRest)
    engine.environments(version.value).then((e) => {
      environments.value = e
    })
    engine.environmentRisks(version.value).then((r) => {
      environmentRisk.value = r
    })
    return () => removeEventListener('hashchange', onHash)
  }, [])

  // the settings menu (a phone) closes when you go somewhere else, or press Escape
  const lastRoute = useRef(route.value)
  useEffect(() => {
    if (lastRoute.current === route.value) return
    lastRoute.current = route.value
    setMenuOpen(false)
  }, [route.value])
  useEffect(() => {
    if (!menuOpen) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false)
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [menuOpen])

  const multiService = Object.keys(registry.manifests).length > 1
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = []
    const metas = [
      ...Object.values(registry.sequenceMeta),
      ...(sequences ?? []).map((s) => ({ ...s.seq.meta })),
    ]
    for (const m of metas) {
      out.push({
        kind: 'seq',
        route: { kind: 'seq', id: m.id },
        title: m.title,
        group: m.tags?.[0] ?? 'sequence',
        tags: m.tags,
        flowGroup: m.group,
        description: m.description,
        hay: `${m.description ?? ''} ${(m.tags ?? []).join(' ')}`,
      })
    }
    for (const m of Object.values(registry.manifests)) {
      for (const o of m.operations) {
        const key = `${m.service}/${o.id}`
        const saved = (variants[key] ?? []).map((v) => v.name).join(' ')
        out.push({
          kind: 'op',
          route: { kind: 'op', key },
          title: o.summary?.replace(/\.$/, '') || o.path,
          group: `${multiService ? `${m.service} · ` : ''}${o.tags[0] ?? 'default'}`,
          service: m.service,
          tag: o.tags[0] ?? 'default',
          method: o.method,
          path: o.path,
          secured: o.secured,
          hay: `${o.id} ${o.method} ${o.path} ${o.tags.join(' ')} ${saved}`,
        })
      }
    }
    return out
  }, [sequences, variants, multiService])

  const r = route.value
  const opInfo = r.kind === 'op' ? findOp(r.key) : undefined
  const seqId = r.kind === 'seq' ? r.id : undefined
  const [opened, setOpened] = useState<SequenceInfo>()
  useEffect(() => {
    if (!seqId) return
    const file = registry.sequenceMeta[seqId]?.file
    if (file) {
      const entry = registry.sequences.filter((e) => e.file === file)
      engine.loadSequences(entry, version.value).then((l) => setOpened(l[0]))
    } else setOpened(sequences?.find((s) => s.seq.meta.id === seqId))
  }, [seqId, sequences, version.value])
  const seqInfo = opened?.seq.meta.id === seqId ? opened : undefined
  const panel = usePanelHost()
  const close = () => go(pageOf(route.value))

  const services = useMemo<ServiceInfo[]>(
    () =>
      Object.values(registry.manifests)
        .map((m) => ({
          id: m.service,
          title: m.title,
          version: m.version,
          ops: m.operations.length,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    [],
  )

  // previous/next within the group the open item belongs to
  const neighbors = useMemo(() => {
    if (r.kind !== 'op' && r.kind !== 'seq') return {}
    const active = entries.find(
      (e) =>
        (e.route.kind === 'op' && r.kind === 'op' && e.route.key === r.key) ||
        (e.route.kind === 'seq' && r.kind === 'seq' && e.route.id === r.id),
    )
    if (!active) return {}
    const sibs = entries.filter((e) =>
      active.kind === 'seq'
        ? e.kind === 'seq'
        : e.service === active.service && e.tag === active.tag,
    )
    const at = sibs.indexOf(active)
    const to = (e?: Entry) => (e ? () => go({ ...e.route, play: '' } as typeof r) : undefined)
    return { prev: to(sibs[at - 1]), next: to(sibs[at + 1]) }
  }, [entries, r.kind === 'op' ? r.key : r.kind === 'seq' ? r.id : ''])

  const navigate = (to: { tab: 'docs' | 'try'; example?: string }) =>
    go(
      r.kind === 'op'
        ? { kind: 'op', key: r.key, play: to.example ?? r.play ?? '', tab: to.tab }
        : r.kind === 'seq'
          ? { kind: 'seq', id: r.id, play: '', tab: to.tab }
          : r,
    )

  return (
    <div
      class="app"
      style={listWidth.value ? { '--sb-list-w': `${listWidth.value}px` } : undefined}
    >
      <header class="header">
        <button type="button" class="brand" onClick={() => go({ kind: 'home' })}>
          {(brand.value.logo ?? ownMark) && (
            <img
              class="brand-logo"
              src={brand.value.logo ?? ownMark}
              alt=""
              style={
                brand.value.logoBackground
                  ? {
                      background: brand.value.logoBackground,
                      padding: '3px 6px',
                      borderRadius: '4px',
                    }
                  : undefined
              }
            />
          )}
          <span class="brand-name">{brand.value.name ?? 'Specbook'}</span>
        </button>
        <button type="button" class="palette-btn" onClick={() => (paletteOpen.value = true)}>
          <span>Jump to an operation or flow…</span>
          <kbd>⌘K</kbd>
        </button>
        <span class="spacer" />
        <span class="header-env">
          <EnvBadge />
        </span>
        <button
          type="button"
          class="menu-btn icon"
          aria-label="Settings"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          ⋯
        </button>
        <div class={`header-controls ${menuOpen ? 'open' : ''}`}>
          {registry.loadFaker && (
            <span
              class="row muted"
              title="Generated values such as {{faker.person.fullName}}: new on every run, or fixed so the same number always gives the same data"
            >
              <label class="row">
                Synthetic data
                <select
                  aria-label="Synthetic data"
                  value={seed.value === undefined ? 'random' : 'fixed'}
                  onChange={(e) => {
                    const fixed = (e.target as HTMLSelectElement).value === 'fixed'
                    seed.value = fixed ? (seed.value ?? 42) : undefined
                  }}
                >
                  <option value="random">New each run</option>
                  <option value="fixed">Fixed</option>
                </select>
              </label>
              {seed.value !== undefined && (
                <input
                  type="number"
                  class="seed-input"
                  aria-label="Seed number"
                  title="The same number gives the same data every run"
                  value={seed.value}
                  onInput={(e) => {
                    const n = (e.target as HTMLInputElement).valueAsNumber
                    seed.value = Number.isFinite(n) ? n : undefined
                  }}
                />
              )}
            </span>
          )}
          {fakerLocales.value.length > 1 && (
            <label class="row muted">
              locale
              <select
                value={locale.value ?? ''}
                onChange={(e) =>
                  (locale.value = (e.target as HTMLSelectElement).value || undefined)
                }
              >
                {fakerLocales.value.map((l) => (
                  <option value={l}>{l}</option>
                ))}
              </select>
            </label>
          )}
          <EnvironmentMenu />
          <label class="row">
            Environment
            <select
              value={env.value}
              onChange={(e) => (env.value = (e.target as HTMLSelectElement).value)}
            >
              {environments.value.map((e) => (
                <option value={e}>{e}</option>
              ))}
            </select>
          </label>
          <GitHubStar />
          <ShareMenu />
          <ThemeToggle />
        </div>
      </header>
      <div class="layout" data-view={r.kind === 'home' ? 'splash' : 'list'}>
        <nav class="list-col" aria-label="Operations and flows">
          <CatalogList entries={entries} services={services} />
        </nav>
        <ListResizer />
        <main class="stage">
          {(r.kind === 'home' || r.kind === 'browse') && <Overview services={services} />}
        </main>
      </div>
      <Palette entries={entries} />
      {panel && r.kind === 'op' && opInfo && (
        <panel.Host
          kind="op"
          modal={false}
          service={opInfo.service}
          op={opInfo.op}
          variants={variants[r.key] ?? []}
          example={r.play ?? ''}
          tab={r.tab}
          onNavigate={navigate}
          onPrev={neighbors.prev}
          onNext={neighbors.next}
          onClose={close}
        />
      )}
      {panel && r.kind === 'seq' && seqInfo && (
        <panel.Host
          kind="seq"
          modal={false}
          info={seqInfo}
          tab={r.tab}
          onNavigate={navigate}
          onPrev={neighbors.prev}
          onNext={neighbors.next}
          onClose={close}
        />
      )}
    </div>
  )
}

function findOp(key: string) {
  const [service, id] = key.split('/') as [string, string]
  const op = registry.manifests[service]?.operations.find((o) => o.id === id)
  return op ? { service, op } : undefined
}
