import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { brandCss } from '../branding'
import type { SequenceInfo, Variant } from '../engine'
import { setNavigator } from '../nav'
import { Host } from '../panel/Host'
import { Panel } from '../panel/Panel'
import { engine, registry } from '../runtime'
import { useMemoryStorage } from '../storage'
import {
  env,
  environmentNote,
  environmentRisk,
  environments,
  features,
  locale,
  version,
} from '../store'
import { panelSheets } from './styles'
import type { Target } from './target'
import { followTheme, setMode } from './theme'

// A page that embeds the panel owns its storage and its address: what a visitor types stays in memory, nothing is
// written to the page's `localStorage`, and a link inside the panel opens inside it. There is no dialog for creating an
// environment or for settings here, so the controls that lead to them are not offered.
useMemoryStorage()
features.value = { createEnvironment: false, environmentSettings: false }

export type { Target } from './target'

interface Loaded {
  variants: Record<string, Variant[]>
}

let loaded: Promise<Loaded> | undefined
const load = () =>
  (loaded ??= (async () => {
    environments.value = await engine.environments(version.value)
    environmentRisk.value = await engine.environmentRisks(version.value)
    environmentNote.value = await engine.environmentNotes(version.value)
    env.value = environments.value.includes('mock') ? 'mock' : (environments.value[0] ?? 'mock')
    // the project's faker locale and accent, as the app applies them
    const cfg = await engine.config(version.value).catch(() => undefined)
    if (cfg?.faker?.default) locale.value = cfg.faker.default
    if (cfg?.branding) applyBranding(cfg.branding)
    return { variants: await engine.loadVariants(registry.requests, version.value) }
  })())

/** Headers are read from the file text, so only the requested module (or the odd unresolved ones) is imported. */
async function loadSequence(id: string) {
  const file = registry.sequenceMeta[id]?.file
  const wanted = (f: string) => (file ? f === file : registry.unresolvedSequences.includes(f))
  const entries = registry.sequences.filter((e) => wanted(e.file))
  const list = await engine.loadSequences(entries, version.value)
  return list.find((s) => s.seq.meta.id === id)
}

function findOperation(t: Target, data: Loaded) {
  // a saved request opens its own operation, on that request
  if (t.request) {
    for (const [key, list] of Object.entries(data.variants)) {
      if (!list.some((v) => v.file === t.request)) continue
      const [service, id] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)]
      const op = registry.manifests[service]?.operations.find((o) => o.id === id)
      if (op) return { service, op, example: `saved:${t.request}` }
    }
    return undefined
  }
  const services = Object.values(registry.manifests)
  const scope = t.service ? services.filter((m) => m.service === t.service) : services
  for (const m of scope) {
    const op = m.operations.find((o) => o.id === t.operation)
    if (op) return { service: m.service, op, example: t.example ?? '' }
  }
  return undefined
}

const isProduction = (name: string) =>
  environmentRisk.value[name] === 'production' ||
  (environmentRisk.value[name] !== 'sandbox' && /prod/i.test(name))

/** Applies the element's environment: unknown names fall back with a note, and auto-run is refused for production. */
function chooseEnvironment(t: Target): string | undefined {
  if (!t.env) return undefined
  if (!environments.value.includes(t.env)) {
    return `Environment "${t.env}" does not exist here (${environments.value.join(', ')}); using "${env.value}".`
  }
  env.value = t.env
  return undefined
}

function Problem({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return (
    <Panel title={title} modal variant="popover" onClose={onClose}>
      <p class="embed-problem" role="alert">
        {text}
      </p>
    </Panel>
  )
}

function Embedded({ target, onClose }: { target: Target; onClose: () => void }) {
  const [data, setData] = useState<Loaded>()
  const [seq, setSeq] = useState<SequenceInfo>()
  const [seqMissing, setSeqMissing] = useState(false)
  const [note, setNote] = useState<string>()
  const [view, setView] = useState<{ tab: 'docs' | 'try'; example: string }>({
    tab: target.tab ?? 'try',
    example: target.example ?? '',
  })
  const navigate = (to: { tab: 'docs' | 'try'; example?: string }) =>
    setView({ tab: to.tab, example: to.example ?? view.example })

  useEffect(() => {
    // one navigation inside the panel at a time: a link in the docs opens that operation or flow here
    setNavigator((r) => {
      if (r.kind === 'op') show({ service: r.key.split('/')[0], operation: r.key.split('/')[1] })
      else if (r.kind === 'seq') show({ sequence: r.id })
    })
    return () => setNavigator(undefined)
  }, [])

  useEffect(() => {
    load().then((d) => {
      setNote(chooseEnvironment(target))
      setData(d)
    })
    if (target.sequence)
      loadSequence(target.sequence).then((s) => (s ? setSeq(s) : setSeqMissing(true)))
  }, [])

  const wantsAutoRun = !!target.autoRun && !isProduction(env.value)
  const autoRunRefused = !!target.autoRun && isProduction(env.value)
  const banner = [target.problem, note, autoRunRefused ? 'Auto-run is off for production.' : '']
    .filter(Boolean)
    .join(' ')

  if (target.sequence) {
    if (seqMissing)
      return (
        <Problem
          title="Flow not found"
          text={`This build has no flow "${target.sequence}".`}
          onClose={onClose}
        />
      )
    return seq && data ? (
      <>
        <Host
          kind="seq"
          info={seq}
          variant="popover"
          tab={view.tab}
          preset={target.inputs}
          autoRun={wantsAutoRun}
          onNavigate={navigate}
          onClose={onClose}
        />
        {banner && <Banner text={banner} />}
      </>
    ) : null
  }
  if (!data) return null
  const found = findOperation(target, data)
  if (!found)
    return (
      <Problem
        title="Request not found"
        text={`This build has no request "${target.request ?? [target.service, target.operation].filter(Boolean).join('/')}".`}
        onClose={onClose}
      />
    )
  return (
    <>
      <Host
        kind="op"
        service={found.service}
        op={found.op}
        variants={data.variants[`${found.service}/${found.op.id}`] ?? []}
        example={view.example || found.example}
        variant="popover"
        tab={view.tab}
        autoRun={wantsAutoRun}
        onNavigate={navigate}
        onClose={onClose}
      />
      {banner && <Banner text={banner} />}
    </>
  )
}

/** A line over the panel for what the page's attributes asked that could not be done. */
function Banner({ text }: { text: string }) {
  return (
    <div class="embed-banner" role="status">
      {text}
    </div>
  )
}

let brandSheet: CSSStyleSheet | undefined
function applyBranding(b: Parameters<typeof brandCss>[0]) {
  const css = brandCss(b, 'host')
  if (!css) return
  brandSheet = new CSSStyleSheet()
  brandSheet.replaceSync(css)
  const panel = document.querySelector<SpecbookPanel>('specbook-panel')
  panel?.adopt(brandSheet)
}

/** The active element through any number of shadow roots, which is where focus goes back to. */
function deepActive(): HTMLElement | null {
  let el = document.activeElement as HTMLElement | null
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement
  return el
}

class SpecbookPanel extends HTMLElement {
  private mount!: HTMLElement
  private top!: HTMLElement
  private opener: HTMLElement | null = null
  private trigger: HTMLElement | undefined
  private native = false

  connectedCallback() {
    if (this.shadowRoot) return
    const root = this.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = panelSheets()
    this.top = document.createElement('div')
    this.top.className = 'sb-top'
    this.native = typeof this.top.showPopover === 'function'
    if (this.native) this.top.setAttribute('popover', 'manual')
    else this.top.className += ' sb-fallback'
    this.top.hidden = !this.native
    this.mount = document.createElement('div')
    this.mount.className = 'sb-root'
    this.top.append(this.mount)
    root.append(this.top)
    if (brandSheet) this.adopt(brandSheet)
  }

  adopt(sheet: CSSStyleSheet) {
    const root = this.shadowRoot
    if (root && !root.adoptedStyleSheets.includes(sheet))
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
  }

  show(target: Target | undefined, trigger?: HTMLElement) {
    if (!target) return this.close()
    if (trigger) {
      this.trigger = trigger
      this.opener = deepActive()
      setExpanded(trigger, true)
      trigger.dispatchEvent(
        new CustomEvent('specbook:open', { bubbles: true, composed: true, detail: target }),
      )
    }
    if (this.isConnected) {
      if (this.followed) setMode(this, target.theme)
      else {
        followTheme(this, target.theme)
        this.followed = true
      }
    }
    if (this.native) {
      if (!this.top.matches(':popover-open')) this.top.showPopover()
    } else this.top.hidden = false
    render(
      <Embedded key={JSON.stringify(target)} target={target} onClose={() => this.close()} />,
      this.mount,
    )
  }

  private followed = false

  close() {
    render(null, this.mount)
    if (this.native) {
      if (this.top.matches(':popover-open')) this.top.hidePopover()
    } else this.top.hidden = true
    const trigger = this.trigger
    this.trigger = undefined
    if (trigger) {
      setExpanded(trigger, false)
      trigger.dispatchEvent(new CustomEvent('specbook:close', { bubbles: true, composed: true }))
    }
    // back to where the person was, which is the button that opened the panel
    const opener = this.opener
    this.opener = null
    // a programmatic open leaves focus on the page's body, so the trigger itself is where it goes back to
    const back =
      opener && opener !== document.body
        ? opener
        : (trigger?.shadowRoot?.querySelector('button') ?? trigger)
    if (back?.isConnected) back.focus()
  }
}

/** The button that opens the panel says whether it is open. */
function setExpanded(trigger: HTMLElement, open: boolean) {
  const button = trigger.shadowRoot?.querySelector('button') ?? trigger
  button.setAttribute('aria-expanded', String(open))
}

customElements.define('specbook-panel', SpecbookPanel)

/** One panel serves every trigger on the page. */
export function show(target: Target, trigger?: HTMLElement) {
  let panel = document.querySelector<SpecbookPanel>('specbook-panel')
  if (!panel) {
    panel = document.createElement('specbook-panel') as SpecbookPanel
    document.body.append(panel)
  }
  panel.show(target, trigger)
}

export function close() {
  document.querySelector<SpecbookPanel>('specbook-panel')?.close()
}
