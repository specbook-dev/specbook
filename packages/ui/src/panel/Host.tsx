import type { SequenceInfo, Variant } from '../engine'
import type { PanelTab } from '../nav'
import { OperationDocs } from './OperationDocs'
import { Panel } from './Panel'
import { type OpInfo, RequestPanel } from './RequestPanel'
import { SequenceDocs } from './SequenceDocs'
import { SequencePanel } from './SequencePanel'

type Props = {
  onClose: () => void
  /** dims the page and traps focus; the standalone site docks the panel beside its list instead */
  modal?: boolean
  tab?: PanelTab
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
        onPrev={p.onPrev}
        onNext={p.onNext}
        onClose={p.onClose}
      >
        <div class="panel-split">
          {tabs}
          <div class={`panel-main ${tab === 'docs' ? 'scroll' : ''}`}>
            {tab === 'docs' ? <SequenceDocs info={p.info} /> : <SequencePanel info={p.info} />}
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
              key={`${p.service}/${p.op.id}`}
              service={p.service}
              op={p.op}
              variants={p.variants}
              initial={p.example}
            />
          )}
        </div>
      </div>
    </Panel>
  )
}
