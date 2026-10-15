import { useMemo } from 'preact/hooks'
import { defaultFor, type FieldSpec, specFromControl } from '../components/Fields'
import type { SequenceInfo } from '../engine'
import { go } from '../nav'
import { useSequenceNotes } from './stepnotes'

const KIND: Record<string, string> = {
  step: 'request',
  each: 'for each item',
  input: 'you choose',
  check: 'check',
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

/**
 * What a sequence does, as documentation: its description (markdown), an optional markdown page from
 * `docs/*.md` with `sequence: <id>` frontmatter, the controls it takes and the operation behind each step.
 */
export function SequenceDocs({ info }: { info: SequenceInfo }) {
  const { seq } = info
  const { intro, notes } = useSequenceNotes(info)

  const params = useMemo(
    () =>
      Object.entries((seq.meta.params ?? {}) as Record<string, unknown>).map(([name, c]) => {
        const spec: FieldSpec = specFromControl(c)
        return { name, spec, initial: defaultFor(spec) }
      }),
    [seq],
  )

  return (
    <article class="doc" data-seq={seq.meta.id}>
      {(seq.meta.tags?.length ?? 0) > 0 && (
        <p class="doc-tags">
          {seq.meta.tags?.map((t) => (
            <span class="chip">{t}</span>
          ))}
        </p>
      )}

      {intro && <div class="doc-custom" dangerouslySetInnerHTML={{ __html: intro }} />}

      {params.length > 0 && (
        <section>
          <h2>Controls</h2>
          <table class="fields">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Default</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {params.map((p) => (
                <tr>
                  <td>
                    <code>{p.name}</code>
                  </td>
                  <td>
                    <span class="chip">{p.spec.kind}</span>
                  </td>
                  <td>
                    <code>{show(p.initial)}</code>
                  </td>
                  <td>{p.spec.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2>Steps</h2>
        <table class="fields">
          <thead>
            <tr>
              <th>#</th>
              <th>Step</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            {seq.nodes.map((n, i) => {
              const def = n.kind === 'step' && typeof n.def !== 'function' ? n.def : undefined
              const op = def?.op
              const note = notes.get(n.name)
              return (
                <>
                  <tr class={note ? 'has-note' : ''}>
                    <td>{i + 1}</td>
                    <td>{n.name}</td>
                    <td>
                      {op ? (
                        <button
                          type="button"
                          class="link"
                          title="Open this operation"
                          onClick={() => go({ kind: 'op', key: `${op.service}/${op.id}` })}
                        >
                          <span class={`method ${op.method}`}>{op.method}</span>{' '}
                          <code>{op.path}</code>
                        </button>
                      ) : (
                        <span class="muted">{KIND[n.kind] ?? n.kind}</span>
                      )}
                    </td>
                  </tr>
                  {note && (
                    <tr class="step-note-row">
                      <td />
                      <td colSpan={2}>
                        <div
                          class="doc-custom step-note"
                          dangerouslySetInnerHTML={{ __html: note }}
                        />
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </section>
    </article>
  )
}
