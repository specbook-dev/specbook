// Which colors the panel and the Play buttons wear: the host page's, unless the author says otherwise. Tokens react to a
// `data-theme` attribute on the host element itself, which is all a shadow root can see.

import type { EmbedTheme } from './target'

export type Scheme = 'light' | 'dark' | undefined

export interface PageTheme {
  /** `data-theme` on the root element (Starlight, many docs themes) */
  attr?: string | null
  /** the root element's classes (`dark`, `light`: Tailwind and others) */
  classes?: string
  /** the computed `color-scheme` of the root element */
  colorScheme?: string
}

/** `undefined` is "auto": follow the operating system. Pure, so it is tested in node. */
export function pageScheme(p: PageTheme): Scheme {
  if (p.attr === 'light' || p.attr === 'dark') return p.attr
  const classes = (p.classes ?? '').split(/\s+/)
  if (classes.includes('dark')) return 'dark'
  if (classes.includes('light')) return 'light'
  const cs = (p.colorScheme ?? '').trim()
  if (cs === 'dark' || cs === 'light') return cs
  return undefined
}

/** What an element asking for `mode` should wear, given the page. */
export function schemeFor(mode: EmbedTheme | undefined, page: PageTheme): Scheme {
  if (mode === 'light' || mode === 'dark') return mode
  if (mode === 'auto') return undefined
  return pageScheme(page)
}

const readPage = (): PageTheme => {
  const root = document.documentElement
  return {
    attr: root.getAttribute('data-theme'),
    classes: root.className,
    colorScheme: getComputedStyle(root).colorScheme,
  }
}

const themed = new Map<HTMLElement, EmbedTheme | undefined>()
let watching = false

const apply = (el: HTMLElement, mode: EmbedTheme | undefined) => {
  const s = schemeFor(mode, readPage())
  if (s) el.setAttribute('data-theme', s)
  else el.removeAttribute('data-theme')
}

/** Keeps `el` in step with the page: set now, and again when the page changes its theme. */
export function followTheme(el: HTMLElement, mode: EmbedTheme | undefined): void {
  themed.set(el, mode)
  apply(el, mode)
  if (watching || typeof MutationObserver === 'undefined') return
  watching = true
  const refresh = () => {
    for (const [e, m] of themed) {
      if (e.isConnected) apply(e, m)
      else themed.delete(e)
    }
  }
  new MutationObserver(refresh).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class', 'style'],
  })
}

/** A new mode for an element already followed (a different Play button opens the one panel). */
export function setMode(el: HTMLElement, mode: EmbedTheme | undefined): void {
  if (themed.has(el)) themed.set(el, mode)
  apply(el, mode)
}
