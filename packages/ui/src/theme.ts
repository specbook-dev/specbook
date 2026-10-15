import { signal } from '@preact/signals'

export type Theme = 'auto' | 'light' | 'dark'

const KEY = 'specbook:theme'

function load(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'auto'
  } catch {
    return 'auto'
  }
}

/** `auto` follows the operating system; the tokens react to `data-theme` on the root element. */
export const theme = signal<Theme>(load())

export function applyTheme(t: Theme = theme.value) {
  if (typeof document === 'undefined') return
  if (t === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
}

const NEXT: Record<Theme, Theme> = { auto: 'light', light: 'dark', dark: 'auto' }

export function cycleTheme() {
  const next = NEXT[theme.value]
  theme.value = next
  try {
    if (next === 'auto') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    /* optional */
  }
  applyTheme(next)
}
