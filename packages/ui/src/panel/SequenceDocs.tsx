import { useMemo } from 'preact/hooks'
import { defaultFor, type FieldSpec, specFromControl } from '../components/Fields'
import type { SequenceInfo } from '../engine'
import { go } from '../nav'
import { show } from './short'
import { useSequenceNotes } from './stepnotes'

const KIND: Record<string, string> = {
  step: 'request',
  script: 'script',
  each: 'for each item',
  input: 'you choose',
  check: 'check',
}

const showValue = (v: unknown) => (typeof v === 'string' ? v : show(v))

interface ControlRow {
  name: string
  kind: string
  initial: string
  description?: string
  depth: number
}

/**
 * A control as the rows of the table: a group or a list is its own row, then a row for each of its fields
 * (`traveler1.name`, `travelers[].name`). A generated default is said to be generated, never made here.
 */
function controlRows(name: string, spec: FieldSpec, depth = 0): ControlRow[] {
  const limits =
    spec.min !== undefined || spec.max !== undefined ? ` ${spec.min ?? ''}–${spec.max ?? ''}` : ''
  const self = {
    name,
    description: spec.description,
    depth,
  }
  if (spec.kind === 'object')
    return [
      { ...self, kind: 'group', initial: '' },
      ...Object.entries(spec.shape ?? {}).flatMap(([k, s]) =>
        controlRows(`${name}.${k}`, s, depth + 1),
      ),
    ]
  if (spec.kind === 'array') {
    const item = spec.item as FieldSpec
    return [
      { ...self, kind: `list${limits}`, initial: '' },
      ...(item.kind === 'object'
        ? Object.entries(item.shape ?? {}).flatMap(([k, s]) =>
            controlRows(`${name}[].${k}`, s, depth + 1),
          )
        : controlRows(`${name}[]`, item, depth + 1)),
    ]
  }
  return [
    {
      ...self,
      kind: spec.kind + limits,
      initial: spec.generate ? 'generated' : showValue(defaultFor(spec)),
    },
  ]
}

/**
 * What a sequence does, as documentation: its description (markdown), an optional markdown page from
 * `docs/*.md` with `sequence: <id>` frontmatter, the controls it takes and the operation behind each step.
 */
export function SequenceDocs({ info }: { info: SequenceInfo }) {
  const { seq } = info
  const { intro, notes } = useSequenceNotes(info)

  const inputs = useMemo(
    () =>
      Object.entries((seq.meta.inputs ?? {}) as Record<string, unknown>).flatMap(([name, c]) => {
        return controlRows(name, specFromControl(c))
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

      {inputs.length > 0 && (
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
              {inputs.map((p) => (
                <tr>
                  <td style={{ paddingLeft: `${8 + p.depth * 14}px` }}>
                    <code>{p.name}</code>
                  </td>
                  <td>
                    <span class="chip">{p.kind}</span>
                  </td>
                  <td>{p.initial && <code>{p.initial}</code>}</td>
                  <td>{p.description}</td>
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
              const op = def?.kind === 'request' ? def.op : undefined
              const script = def?.kind === 'script' ? def : undefined
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
                      ) : script ? (
                        <span class="muted">
                          script <code>{script.meta.id}</code> · {script.meta.runtime}
                        </span>
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
