import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { SequenceInfo, Variant } from '../engine'
import { Host } from '../panel/Host'
import { engine, registry } from '../runtime'
import { env, environmentRisk, environments, version } from '../store'
import { panelSheets } from './styles'

export interface Target {
  service?: string
  operation?: string
  sequence?: string
  example?: string
  /** open on the Docs tab instead of Try */
  tab?: 'docs' | 'try'
}

interface Loaded {
  variants: Record<string, Variant[]>
}

let loaded: Promise<Loaded> | undefined
const load = () =>
  (loaded ??= (async () => {
    environments.value = await engine.environments(version.value)
    environmentRisk.value = await engine.environmentRisks(version.value)
    env.value = environments.value.includes('mock') ? 'mock' : (environments.value[0] ?? 'mock')
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

function findOperation(t: Target) {
  const services = Object.values(registry.manifests)
  const scope = t.service ? services.filter((m) => m.service === t.service) : services
  for (const m of scope) {
    const op = m.operations.find((o) => o.id === t.operation)
    if (op) return { service: m.service, op }
  }
  return undefined
}

function Embedded({ target, onClose }: { target: Target; onClose: () => void }) {
  const [data, setData] = useState<Loaded>()
  const [seq, setSeq] = useState<SequenceInfo>()
  const [view, setView] = useState<{ tab: 'docs' | 'try'; example: string }>({
    tab: target.tab ?? 'try',
    example: target.example ?? '',
  })
  const navigate = (to: { tab: 'docs' | 'try'; example?: string }) =>
    setView({ tab: to.tab, example: to.example ?? view.example })
  useEffect(() => {
    load().then(setData)
    if (target.sequence) loadSequence(target.sequence).then(setSeq)
  }, [])
  if (target.sequence)
    return seq ? (
      <Host kind="seq" info={seq} tab={view.tab} onNavigate={navigate} onClose={onClose} />
    ) : null
  if (!data) return null
  const found = findOperation(target)
  if (!found) return null
  return (
    <Host
      kind="op"
      service={found.service}
      op={found.op}
      variants={data.variants[`${found.service}/${found.op.id}`] ?? []}
      example={view.example}
      tab={view.tab}
      onNavigate={navigate}
      onClose={onClose}
    />
  )
}

class SpecbookPanel extends HTMLElement {
  private mount!: HTMLElement

  connectedCallback() {
    if (this.shadowRoot) return
    const root = this.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = panelSheets()
    this.mount = document.createElement('div')
    this.mount.className = 'sb-root'
    root.append(this.mount)
  }

  show(target: Target | undefined) {
    render(
      target ? <Embedded target={target} onClose={() => this.show(undefined)} /> : null,
      this.mount,
    )
  }
}

customElements.define('specbook-panel', SpecbookPanel)

/** One panel serves every Play button on the page. */
export function show(target: Target) {
  let panel = document.querySelector<SpecbookPanel>('specbook-panel')
  if (!panel) {
    panel = document.createElement('specbook-panel') as SpecbookPanel
    document.body.append(panel)
  }
  panel.show(target)
}
