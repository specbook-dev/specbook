import { signal } from '@preact/signals'
import type { BrandingConfig } from '@specbook/core'

export interface Brand {
  /** the project's config has been read; until then the overview would show its fallback text */
  ready?: boolean
  name?: string
  title?: string
  tagline?: string
  logo?: string
  /** background behind a logo that needs one (from the spec's x-logo) */
  logoBackground?: string
  favicon?: string
  links: { label: string; href: string }[]
  /** `false` hides the "Powered by Specbook" line */
  badge?: boolean
}

/** The resolved branding: config text and colours, plus logo/favicon from URLs or `.specbook/branding/`. */
export const brand = signal<Brand>({ links: [], ready: false })

function rgb(hex: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return undefined
  const h =
    (m[1] as string).length === 3
      ? [...(m[1] as string)].map((c) => c + c).join('')
      : (m[1] as string)
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

/** Whichever of white and near-black has the better contrast ratio on the accent. */
export function onAccent(hex: string): string | undefined {
  const c = rgb(hex)
  if (!c) return undefined
  const lin = c.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  const l = 0.2126 * (lin[0] as number) + 0.7152 * (lin[1] as number) + 0.0722 * (lin[2] as number)
  const dark = 0.006 // #0b1020
  const onWhite = 1.05 / (l + 0.05)
  const onDark = (l + 0.05) / (dark + 0.05)
  return onDark > onWhite ? '#0b1020' : '#ffffff'
}

const tokens = (accent: string) =>
  `--sb-accent:${accent};--sb-accent-hover:color-mix(in srgb,${accent} 82%,black);` +
  `--sb-focus-ring:color-mix(in srgb,${accent} 45%,white);` +
  (onAccent(accent) ? `--sb-text-on-accent:${onAccent(accent)};` : '')

/**
 * The accent as CSS: unlayered, so it wins over the default tokens. A separate dark value applies
 * under `prefers-color-scheme: dark` (unless the light theme is forced) and `data-theme="dark"`.
 */
export function brandCss(b: Pick<BrandingConfig, 'accent' | 'accentDark'>): string {
  if (!b.accent && !b.accentDark) return ''
  const light = b.accent ? `:root{${tokens(b.accent)}}` : ''
  if (!b.accentDark) return light
  return (
    `${light}` +
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${tokens(b.accentDark)}}}` +
    `:root[data-theme="dark"]{${tokens(b.accentDark)}}`
  )
}

/** Applies the branding to the page: accent tokens, tab title and favicon. */
export function applyBranding(
  cfg: BrandingConfig | undefined,
  resolved: Brand,
  fallbackName: string,
) {
  if (typeof document === 'undefined') return
  let style = document.getElementById('specbook-brand') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'specbook-brand'
    document.head.append(style)
  }
  style.textContent = cfg ? brandCss(cfg) : ''
  const name = resolved.name ?? fallbackName
  document.title = resolved.title ? `${name} · ${resolved.title}` : name
  if (resolved.favicon || resolved.logo) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.append(link)
    }
    link.href = (resolved.favicon ?? resolved.logo) as string
  }
}
