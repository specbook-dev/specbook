import complete from 'prism-code-editor/autocomplete.css?inline'
import completeIcons from 'prism-code-editor/autocomplete-icons.css?inline'
import layout from 'prism-code-editor/layout.css?inline'
import app from '../styles/app.css?inline'
import panel from '../styles/panel.css?inline'
import tokens from '../styles/tokens.css?inline'

const sheet = (css: string) => {
  const s = new CSSStyleSheet()
  s.replaceSync(css)
  return s
}

/** `tokens` first so its layer order wins; the host page's CSS can't reach in, ours can't leak out. */
export const playSheets = (css: string) => [sheet(tokens), sheet(css)]
export const panelSheets = () => [
  sheet(tokens),
  sheet(layout),
  sheet(complete),
  sheet(completeIcons),
  sheet(app),
  sheet(panel),
  sheet(root),
]

/** Inline `color`/`font` on the host would be beaten by host-page rules, so the root element sets them. */
const root = '.sb-root{font:14px/1.5 var(--sb-font-sans);color:var(--sb-text)}'
