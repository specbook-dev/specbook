import { signal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import type { FieldDoc } from '../fielddoc'
import { inlineSummary, plainText } from '../markdown'
import { kv } from '../storage'
import { Combo } from './Combo'
import type { FieldRow } from './draft'

export interface Documented {
  name: string
  doc?: FieldDoc
  /** array parameter: the key may repeat */
  repeat?: boolean
  file?: boolean
}

interface Props {
  title: string
  rows: FieldRow[]
  onChange: (rows: FieldRow[]) => void
  /** Documented fields missing from `rows` are listed unchecked, so the grid doubles as the docs. */
  documented?: Documented[]
  /** docs for keys that are not in `documented` (e.g. bracket keys of a form body) */
  docFor?: (key: string) => FieldDoc | undefined
  /** keys are fixed and rows cannot be added, removed or switched off (path parameters, variables) */
  fixed?: boolean
  /** row key to highlight as a problem */
  bad?: string
  placeholder?: string
  /** the grid sits under a tab that already names it */
  bare?: boolean
  /** values are shown, not edited (a saved request carries its own) */
  readOnly?: boolean
}

type Shown = FieldRow & { virtual?: true }

const COLS_KEY = 'specbook:grid-cols'
const DEFAULT_COLS = { key: 26, val: 34 }
const MIN_COL = 10

/** Key and Value column widths as percentages of the table, shared by every grid; Description takes the rest. */
const cols = signal(loadCols())

function loadCols(): { key: number; val: number } {
  try {
    const c = JSON.parse(kv.local.getItem(COLS_KEY) ?? 'null')
    if (c && c.key >= MIN_COL && c.val >= MIN_COL && c.key + c.val <= 100 - MIN_COL) return c
  } catch {
    /* fall through */
  }
  return DEFAULT_COLS
}

function setCols(next: { key: number; val: number } | undefined) {
  const c = next ?? DEFAULT_COLS
  const key = Math.min(100 - 2 * MIN_COL, Math.max(MIN_COL, c.key))
  const val = Math.min(100 - key - MIN_COL, Math.max(MIN_COL, c.val))
  cols.value = { key: Math.round(key * 10) / 10, val: Math.round(val * 10) / 10 }
  try {
    if (next) kv.local.setItem(COLS_KEY, JSON.stringify(cols.value))
    else kv.local.removeItem(COLS_KEY)
  } catch {
    /* optional */
  }
}

/** The shared column layout, so other grids (sequence controls) line up with the parameter grids. */
export function GridColgroup() {
  return (
    <colgroup>
      <col style={{ width: '36px' }} />
      <col style={{ width: `${cols.value.key}%` }} />
      <col style={{ width: `${cols.value.val}%` }} />
      <col />
      <col style={{ width: '60px' }} />
    </colgroup>
  )
}

/** The handle on a column's right edge: drag, ←/→ to nudge, double-click to reset. */
function ColResizer({ which, table }: { which: 'key' | 'val'; table: () => HTMLElement | null }) {
  const move = (dPct: number) => {
    const c = cols.value
    // the Key edge trades width with Value; the Value edge trades with Description
    setCols(
      which === 'key'
        ? { key: c.key + dPct, val: c.val - dPct }
        : { key: c.key, val: c.val + dPct },
    )
  }
  const drag = (e: PointerEvent) => {
    e.preventDefault()
    const width = table()?.getBoundingClientRect().width ?? 1
    let last = e.clientX
    document.body.classList.add('resizing')
    const onMove = (m: PointerEvent) => {
      move(((m.clientX - last) / width) * 100)
      last = m.clientX
    }
    const up = () => {
      document.body.classList.remove('resizing')
      removeEventListener('pointermove', onMove)
      removeEventListener('pointerup', up)
    }
    addEventListener('pointermove', onMove)
    addEventListener('pointerup', up)
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no native element
    <span
      class="col-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${which === 'key' ? 'Key' : 'Value'} column`}
      aria-valuenow={Math.round(cols.value[which])}
      aria-valuemin={MIN_COL}
      aria-valuemax={100 - 2 * MIN_COL}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={drag}
      onDblClick={() => setCols(undefined)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          move(e.key === 'ArrowLeft' ? -2 : 2)
        }
      }}
    />
  )
}

const KEY = 1
const VALUE = 2

/** `key=value`, `key: value` or `key<TAB>value` lines, as copied from docs, curl or a spreadsheet. */
export function parsePasted(text: string): { key: string; value: string }[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const at = l.search(/[=\t]|:\s/)
      return at < 0
        ? { key: l, value: '' }
        : { key: l.slice(0, at).trim(), value: l.slice(at + 1).trim() }
    })
}

const Icon = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    aria-hidden="true"
  >
    <path d={d} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
)

export function ParamGrid({
  title,
  rows,
  onChange,
  documented = [],
  docFor,
  fixed,
  bad,
  placeholder,
  bare,
  readOnly,
}: Props) {
  const root = useRef<HTMLElement>(null)
  const table = useRef<HTMLTableElement>(null)
  const focusNext = useRef<string | undefined>(undefined)
  const have = new Set(rows.map((r) => r.key))
  const virtual: Shown[] = documented
    .filter((d) => !have.has(d.name))
    .map((d) => ({ key: d.name, value: '', enabled: false, virtual: true }))
  const all: Shown[] = [...rows, ...virtual]
  const info = (key: string) => documented.find((d) => d.name === key)
  const docOf = (key: string) => info(key)?.doc ?? docFor?.(key)

  useEffect(() => {
    if (!focusNext.current) return
    const el = root.current?.querySelector<HTMLInputElement>(`[data-cell="${focusNext.current}"]`)
    focusNext.current = undefined
    if (!el) return
    el.focus()
    el.setSelectionRange?.(el.value.length, el.value.length)
  })

  const real = (r: Shown) => !r.virtual || r.enabled || r.value !== '' || r.file
  const commit = (next: Shown[]) => onChange(next.filter(real).map(({ virtual: _v, ...r }) => r))
  const patch = (i: number, p: Partial<FieldRow>) =>
    commit(all.map((r, j) => (j === i ? { ...r, ...p } : r)))

  const go = (i: number, col: number) =>
    root.current?.querySelector<HTMLElement>(`[data-cell="${i}:${col}"]`)?.focus()
  const keys = (i: number, col: number) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault()
      go(i + (e.shiftKey ? -1 : 1), col)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      go(i - 1, col)
    }
  }

  const repeat = (i: number) => {
    const r = all[i] as Shown
    const options = docOf(r.key)?.enum ?? []
    const used = new Set(all.filter((x) => x.key === r.key).map((x) => x.value))
    const value = options.find((o) => !used.has(o)) ?? ''
    const added: Shown = { key: r.key, value, enabled: true }
    const next = [...all]
    next.splice(i + 1, 0, added)
    focusNext.current = `${next.filter(real).indexOf(added)}:${VALUE}`
    commit(next)
  }

  const paste = (e: ClipboardEvent, at: number) => {
    const text = e.clipboardData?.getData('text') ?? ''
    if (!/\r?\n/.test(text.trim())) return
    e.preventDefault()
    const added = parsePasted(text).map((p) => ({ ...p, enabled: true }))
    const next = [...rows]
    next.splice(at, at < rows.length && !rows[at]?.key ? 1 : 0, ...added)
    onChange(next)
  }

  const ghost = all.length
  return (
    <section class="grid" aria-label={title} ref={root}>
      {!bare && <h3>{title}</h3>}
      <table ref={table}>
        <GridColgroup />
        <thead>
          <tr>
            <th class="g-check" />
            <th class="g-key">
              Key
              <ColResizer which="key" table={() => table.current} />
            </th>
            <th class="g-val">
              Value
              <ColResizer which="val" table={() => table.current} />
            </th>
            <th class="g-doc">Description</th>
            <th class="g-act" />
          </tr>
        </thead>
        <tbody>
          {all.map((r, i) => {
            const d = docOf(r.key)
            const isFile = info(r.key)?.file
            const locked = fixed || readOnly || r.virtual || info(r.key)
            return (
              <tr class={`${r.enabled ? '' : 'off'} ${bad === r.key ? 'bad' : ''}`} key={i}>
                <td class="g-check">
                  <input
                    type="checkbox"
                    aria-label={`Send ${r.key}`}
                    checked={r.enabled}
                    disabled={fixed || readOnly}
                    onChange={(e) => patch(i, { enabled: (e.target as HTMLInputElement).checked })}
                  />
                </td>
                <td class="g-key">
                  {locked ? (
                    <span class="key">
                      <code>{r.key}</code>
                      {d?.required && (
                        <span class="req" title="required">
                          *
                        </span>
                      )}
                    </span>
                  ) : (
                    <input
                      class="cell"
                      data-cell={`${i}:${KEY}`}
                      value={r.key}
                      placeholder="key"
                      aria-label="Name"
                      onInput={(e) => patch(i, { key: (e.target as HTMLInputElement).value })}
                      onKeyDown={keys(i, KEY)}
                      onPaste={(e) => paste(e, i)}
                    />
                  )}
                </td>
                <td class="g-val">
                  {isFile ? (
                    <label class="file-cell">
                      <input
                        type="file"
                        disabled={readOnly}
                        aria-label={`File for ${r.key}`}
                        onChange={(e) => {
                          const file = (e.target as HTMLInputElement).files?.[0]
                          if (file) patch(i, { file, value: file.name, enabled: true })
                        }}
                      />
                      <span class={r.value ? '' : 'muted'}>{r.value || 'Choose a file…'}</span>
                    </label>
                  ) : d?.enum ? (
                    <Combo
                      value={r.value}
                      options={d.enum.map(String)}
                      label={r.key}
                      cell={`${i}:${VALUE}`}
                      readOnly={readOnly}
                      placeholder="value"
                      onKeyDown={keys(i, VALUE)}
                      onChange={(value) => patch(i, { value, enabled: true })}
                    />
                  ) : (
                    <input
                      class="cell"
                      data-cell={`${i}:${VALUE}`}
                      value={r.value}
                      readOnly={readOnly}
                      placeholder={placeholder ?? 'value'}
                      aria-label={`Value of ${r.key}`}
                      onInput={(e) =>
                        patch(i, { value: (e.target as HTMLInputElement).value, enabled: true })
                      }
                      onKeyDown={keys(i, VALUE)}
                    />
                  )}
                </td>
                <td class="g-doc" title={plainText(d?.description)}>
                  {d && (
                    <>
                      <span class="chip">{d.type}</span>{' '}
                      <span
                        class="doc-inline"
                        dangerouslySetInnerHTML={{ __html: inlineSummary(d.description) }}
                      />
                    </>
                  )}
                </td>
                <td class="g-act">
                  {!fixed && !readOnly && r.key && (
                    <button
                      type="button"
                      class="icon"
                      title="Repeat this key with another value"
                      aria-label={`Repeat ${r.key}`}
                      onClick={() => repeat(i)}
                    >
                      <Icon d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" />
                    </button>
                  )}
                  {!fixed && !readOnly && !r.virtual && (
                    <button
                      type="button"
                      class="icon"
                      title="Remove"
                      aria-label={`Remove ${r.key}`}
                      onClick={() => commit(all.filter((_, j) => j !== i))}
                    >
                      <Icon d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          {!fixed && !readOnly && (
            <tr class="ghost" key={ghost}>
              <td class="g-check" />
              <td class="g-key">
                <input
                  class="cell"
                  data-cell={`${ghost}:${KEY}`}
                  value=""
                  placeholder="Add a key"
                  aria-label="New key"
                  onInput={(e) => {
                    // the new row lands before the unchecked documented ones, so focus follows it there
                    focusNext.current = `${rows.length}:${KEY}`
                    onChange([
                      ...rows,
                      { key: (e.target as HTMLInputElement).value, value: '', enabled: true },
                    ])
                  }}
                  onKeyDown={keys(ghost, KEY)}
                  onPaste={(e) => paste(e, rows.length)}
                />
              </td>
              <td class="g-val" />
              <td class="g-doc" />
              <td class="g-act" />
            </tr>
          )}
        </tbody>
      </table>
    </section>
  )
}
