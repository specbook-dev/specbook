import { useEffect, useState } from 'preact/hooks'
import type { SequenceInfo, Variant } from '../engine'
import type { PanelTab } from '../nav'
import { OperationDocs } from './OperationDocs'
import { Panel } from './Panel'
import { type OpInfo, RequestPanel } from './RequestPanel'

/**
 * A flow's views are fetched when a flow is opened: opening one request does not pay for the form of a flow's inputs
 * (the embed's first click is measured, in bytes).
 */
function useLoaded<T>(load: () => Promise<T>, wanted: boolean): T | undefined {
  const [loaded, setLoaded] = useState<T>()
  useEffect(() => {
    if (wanted) void load().then(setLoaded)
  }, [wanted])
  return loaded
}
const loadSequencePanel = () => import('./SequencePanel')
const loadSequenceDocs = () => import('./SequenceDocs')

type Props = {
  onClose: () => void
  /** dims the page and traps focus; the standalone site docks the panel beside its list instead */
  modal?: boolean
  tab?: PanelTab
  /** `popover`: a centered dialog (a sheet from the bottom on a phone); `side`: the app's sheet from the right */
  variant?: 'side' | 'popover'
  /** an embed's preset flow inputs, and whether to run as soon as it is ready */
  preset?: Record<string, unknown>
  autoRun?: boolean
  /** switch tab, optionally opening a named example */
  onNavigate: (to: { tab: PanelTab; example?: string }) => void
  onPrev?: () => void
  onNext?: () => void
} & (
  | { kind: 'op'; service: string; op: OpInfo; variants: Variant[]; example: string }
  | { kind: 'seq'; info: SequenceInfo }
)

/** Lazy entry for everything the side panel needs, so the catalog carries no editor code. */
export function Host(p: Props) {
  const tab = p.tab ?? 'try'
  const panelView = useLoaded(loadSequencePanel, p.kind === 'seq' && tab !== 'docs')
  const docsView = useLoaded(loadSequenceDocs, p.kind === 'seq' && tab === 'docs')
  const tabs = (
    <div class="rq-tabs panel-tabs" role="tablist">
      {(
        [
          ['try', p.kind === 'seq' ? 'Run' : 'Try'],
          ['docs', 'Docs'],
        ] as const
      ).map(([id, label]) => (
        <button
          type="button"
          role="tab"
          aria-selected={tab === id}
          class={`rq-tab ${tab === id ? 'on' : ''}`}
          onClick={() => p.onNavigate({ tab: id })}
        >
          {label}
        </button>
      ))}
    </div>
  )

  if (p.kind === 'seq')
    return (
      <Panel
        title={p.info.seq.meta.title}
        subtitle="Sequence"
        flush
        modal={p.modal}
        variant={p.variant}
        onPrev={p.onPrev}
        onNext={p.onNext}
        onClose={p.onClose}
      >
        <div class="panel-split">
          {tabs}
          <div class={`panel-main ${tab === 'docs' ? 'scroll' : ''}`}>
            {tab === 'docs'
              ? docsView && <docsView.SequenceDocs info={p.info} />
              : panelView && (
                  <panelView.SequencePanel info={p.info} preset={p.preset} autoRun={p.autoRun} />
                )}
          </div>
        </div>
      </Panel>
    )
  return (
    <Panel
      title={p.op.summary?.replace(/\.$/, '') || p.op.path}
      subtitle={`${p.op.method} ${p.op.path}`}
      flush
      modal={p.modal}
      variant={p.variant}
      onPrev={p.onPrev}
      onNext={p.onNext}
      onClose={p.onClose}
    >
      <div class="panel-split">
        {tabs}
        <div class={`panel-main ${tab === 'docs' ? 'scroll' : ''}`}>
          {tab === 'docs' ? (
            <OperationDocs
              key={`${p.service}/${p.op.id}`}
              service={p.service}
              op={p.op}
              variants={p.variants}
              onTry={(example) => p.onNavigate({ tab: 'try', example })}
            />
          ) : (
            <RequestPanel
              key={`${p.service}/${p.op.id}${p.example.startsWith('saved:') ? `@${p.example}` : ''}`}
              service={p.service}
              op={p.op}
              variants={p.variants}
              initial={p.example}
              autoRun={p.autoRun}
            />
          )}
        </div>
      </div>
    </Panel>
  )
}
