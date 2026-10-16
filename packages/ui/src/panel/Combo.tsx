import { useEffect, useRef, useState } from 'preact/hooks'

interface Props {
  value: string
  options: string[]
  onChange: (value: string) => void
  label: string
  placeholder?: string
  /** forwarded so the grid can move between rows with Enter and the arrow keys */
  onKeyDown?: (e: KeyboardEvent) => void
  cell?: string
  /** shown, not edited: no list, no typing */
  readOnly?: boolean
}

/** A text input with the spec's allowed values as a dropdown; any other value can still be typed. */
export function Combo({
  value,
  options,
  onChange,
  label,
  placeholder,
  onKeyDown,
  cell,
  readOnly,
}: Props) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(-1)
  const [pos, setPos] = useState<Record<string, string>>()
  const box = useRef<HTMLDivElement>(null)

  /**
   * The list is `fixed` so the grid's rounded, clipped table and the scrolling pane can't cut it off. A
   * `fixed` box is placed against the viewport unless an ancestor contains it (a `container-type` does), so
   * a probe filling the inset-0 box says where its coordinates really start.
   */
  const place = () => {
    const el = box.current
    const r = el?.getBoundingClientRect()
    if (!el || !r) return
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none'
    el.append(probe)
    const cb = probe.getBoundingClientRect()
    probe.remove()
    const below = innerHeight - r.bottom - 8
    const flip = below < 160 && r.top > below
    // strings with units: Preact 11 sets style properties as given
    setPos({
      left: `${r.left - cb.left}px`,
      width: `${Math.max(r.width, 160)}px`,
      maxHeight: `${Math.min(240, (flip ? r.top : below) - 4)}px`,
      ...(flip ? { bottom: `${cb.bottom - r.top + 2}px` } : { top: `${r.bottom + 2 - cb.top}px` }),
    })
  }

  useEffect(() => {
    if (!open) {
      // the next opening starts unplaced, not where it last was
      setPos(undefined)
      return
    }
    place()
    // the list follows its field when something scrolls (a phone moves the field clear of its keyboard),
    // and goes once the field is out of sight
    const follow = (e: Event) => {
      if (e.target instanceof Node && box.current?.contains(e.target)) return
      const r = box.current?.getBoundingClientRect()
      if (!r || r.bottom < 0 || r.top > innerHeight) setOpen(false)
      else place()
    }
    const close = () => setOpen(false)
    addEventListener('scroll', follow, true)
    addEventListener('resize', close)
    return () => {
      removeEventListener('scroll', follow, true)
      removeEventListener('resize', close)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!e.composedPath().includes(box.current as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away, true)
    return () => document.removeEventListener('mousedown', away, true)
  }, [open])

  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
    setAt(-1)
  }

  return (
    <div class="combo" ref={box}>
      <input
        class="cell"
        data-cell={cell}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        aria-expanded={open}
        role="combobox"
        autocomplete="off"
        readOnly={readOnly}
        onFocus={() => !readOnly && setOpen(true)}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (open && e.key === 'ArrowDown') {
            e.preventDefault()
            setAt((at + 1) % options.length)
          } else if (open && e.key === 'ArrowUp') {
            e.preventDefault()
            setAt((at - 1 + options.length) % options.length)
          } else if (open && e.key === 'Enter' && at >= 0) {
            e.preventDefault()
            pick(options[at] as string)
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation()
            setOpen(false)
          } else {
            if (e.key === 'Enter' || e.key === 'Tab') setOpen(false)
            onKeyDown?.(e)
          }
        }}
      />
      <button
        type="button"
        class="combo-toggle"
        tabIndex={-1}
        aria-label={`Show ${label} options`}
        disabled={readOnly}
        onClick={() => setOpen(!open)}
      >
        ▾
      </button>
      {open && (
        // until it is placed it waits out of sight at the corner: in the flow of the table it would grow
        // the scrolling pane for a moment, and the pane jumps to the bottom
        <div
          class="combo-list"
          role="listbox"
          style={pos ?? { top: '0px', left: '0px', visibility: 'hidden' }}
        >
          {options.map((o, i) => (
            <button
              type="button"
              role="option"
              aria-selected={o === value}
              class={`${o === value ? 'on' : ''} ${i === at ? 'at' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
