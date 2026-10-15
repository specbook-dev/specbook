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
}

/** A text input with the spec's allowed values as a dropdown; any other value can still be typed. */
export function Combo({ value, options, onChange, label, placeholder, onKeyDown, cell }: Props) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(-1)
  const [pos, setPos] = useState<Record<string, string>>()
  const box = useRef<HTMLDivElement>(null)

  /** The list is `fixed` so the grid's rounded, clipped table and the scrolling pane can't cut it off. */
  const place = () => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return
    const below = innerHeight - r.bottom - 8
    const flip = below < 160 && r.top > below
    // strings with units: Preact 11 sets style properties as given
    setPos({
      left: `${r.left}px`,
      width: `${Math.max(r.width, 160)}px`,
      maxHeight: `${Math.min(240, (flip ? r.top : below) - 4)}px`,
      ...(flip ? { bottom: `${innerHeight - r.top + 2}px` } : { top: `${r.bottom + 2}px` }),
    })
  }

  useEffect(() => {
    if (!open) return
    place()
    const close = (e: Event) => {
      if (!(e.target instanceof Node && box.current?.contains(e.target))) setOpen(false)
    }
    addEventListener('scroll', close, true)
    addEventListener('resize', close)
    return () => {
      removeEventListener('scroll', close, true)
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
        onFocus={() => setOpen(true)}
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
        onClick={() => setOpen(!open)}
      >
        ▾
      </button>
      {open && (
        <div class="combo-list" role="listbox" style={pos}>
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
