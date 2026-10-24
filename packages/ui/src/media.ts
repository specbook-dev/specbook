import { useEffect, useState } from 'preact/hooks'

/** The widths the panel's layout changes at; keep them in step with panel.css. */
export const NARROW = '(max-width: 900px)' // the flow panel is one column
export const PHONE = '(max-width: 820px)' // the panel fills the screen, and a step opens as a sheet

/** Whether a media query matches now, and again when it changes. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof matchMedia === 'function' && matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(query)
    const change = () => setMatches(mq.matches)
    change()
    mq.addEventListener('change', change)
    return () => mq.removeEventListener('change', change)
  }, [query])
  return matches
}
