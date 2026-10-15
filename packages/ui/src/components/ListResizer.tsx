import { signal } from '@preact/signals'

const KEY = 'specbook:list-width'
export const MIN = 280
const maxWidth = () => Math.round(innerWidth * 0.55)

function load(): number | undefined {
  try {
    const n = Number(localStorage.getItem(KEY))
    return n >= MIN ? n : undefined
  } catch {
    return undefined
  }
}

/** The list column's width in px; undefined = the stylesheet's responsive default. */
export const listWidth = signal<number | undefined>(load())

function set(w: number | undefined) {
  listWidth.value = w === undefined ? undefined : Math.round(Math.max(MIN, Math.min(maxWidth(), w)))
  try {
    if (listWidth.value === undefined) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(listWidth.value))
  } catch {
    /* optional */
  }
}

/** A draggable (and keyboard-operable) edge on the list column; double-click restores the default. */
export function ListResizer() {
  const drag = (e: PointerEvent) => {
    e.preventDefault()
    document.body.classList.add('resizing')
    const move = (m: PointerEvent) => set(m.clientX)
    const up = () => {
      document.body.classList.remove('resizing')
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }
  const current = () =>
    listWidth.value ?? document.querySelector<HTMLElement>('.list-col')?.offsetWidth ?? 360

  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no native element
    <div
      class="list-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the list"
      aria-valuenow={listWidth.value}
      aria-valuemin={MIN}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={drag}
      onDblClick={() => set(undefined)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          set(current() - 24)
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          set(current() + 24)
        }
      }}
    />
  )
}
