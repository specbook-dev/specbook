import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { type Entry, go, paletteOpen, search } from '../nav'

export function Palette({ entries }: { entries: Entry[] }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const open = paletteOpen.value

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        paletteOpen.value = !paletteOpen.value
      } else if (e.key === 'Escape') paletteOpen.value = false
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      setTimeout(() => input.current?.focus(), 0)
    }
  }, [open])

  const results = useMemo(() => search(entries, q, 30), [entries, q])
  if (!open) return null

  const choose = (e: Entry | undefined) => {
    if (!e) return
    paletteOpen.value = false
    go(e.route)
  }

  return (
    <div class="palette-backdrop">
      <button
        type="button"
        class="palette-dismiss"
        aria-label="Close"
        onClick={() => (paletteOpen.value = false)}
      />
      <div class="palette" role="dialog" aria-label="Jump to">
        <input
          ref={input}
          type="text"
          placeholder="Jump to a sequence or operation…"
          value={q}
          onInput={(e) => {
            setQ((e.target as HTMLInputElement).value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel(Math.min(results.length - 1, sel + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel(Math.max(0, sel - 1))
            } else if (e.key === 'Enter') choose(results[sel])
          }}
        />
        <ul>
          {results.map((e, i) => (
            <li>
              <button
                type="button"
                class={i === sel ? 'sel' : ''}
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(e)}
              >
                <span class="p-title">{e.title}</span>
                <span class="muted">{e.kind === 'seq' ? 'Sequence' : e.group}</span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li class="muted pad">Nothing matches “{q}”</li>}
        </ul>
      </div>
    </div>
  )
}
