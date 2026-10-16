import { parseTarget, type Target } from './embed/target'
import { followTheme } from './embed/theme'
import tokens from './styles/tokens.css?inline'

const css = `button {
  font: 13px/1.4 var(--sb-font-sans);
  margin-inline: 0.5em;
  padding: 0 0.6em;
  cursor: pointer;
  border: 1px solid var(--sb-border);
  border-radius: var(--sb-radius-control);
  background: var(--sb-surface);
  color: var(--sb-accent);
}
button:hover { background: var(--sb-surface-raised); }
button:focus-visible { outline: 2px solid var(--sb-focus-ring); }
@media (pointer: coarse) { button { min-height: 44px; min-width: 44px; } }`

let opened = false

/** The panel (editor, grammars, runner) is a separate chunk fetched on first click. */
export async function open(target: Target, trigger?: HTMLElement): Promise<void> {
  const { show } = await import('./embed/panel')
  opened = true
  show(target, trigger)
}

/** Closes the panel, if it is open. */
export async function close(): Promise<void> {
  if (!opened) return
  const { close: closePanel } = await import('./embed/panel')
  closePanel()
}

const nameOf = (t: Target) => t.sequence ?? t.request ?? t.operation ?? ''

class SpecbookPlay extends HTMLElement {
  target: Target = {}

  connectedCallback() {
    if (this.shadowRoot) return
    const root = this.attachShadow({ mode: 'open' })
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(`${tokens}\n@layer base{${css}}`)
    root.adoptedStyleSheets = [sheet]
    const b = document.createElement('button')
    b.type = 'button'
    b.part.add('play')
    b.textContent = '▶ Play'
    b.setAttribute('aria-haspopup', 'dialog')
    b.setAttribute('aria-expanded', 'false')
    b.setAttribute('aria-label', `Play ${nameOf(this.target)}`.trim())
    b.addEventListener('click', () => open(this.target, this))
    root.append(b)
    followTheme(this, this.target.theme)
  }
}

customElements.define('specbook-play', SpecbookPlay)

/** A button or a link that carries the attribute is the trigger itself; anything else gets a Play button beside it. */
const isTrigger = (el: HTMLElement) => el.matches('button, a[href], [role="button"]')

function attach(el: HTMLElement) {
  if (el.dataset.specbookReady !== undefined) return
  el.dataset.specbookReady = ''
  const target = parseTarget(el)
  if (!target) return
  if (isTrigger(el)) {
    el.setAttribute('aria-haspopup', 'dialog')
    if (!el.hasAttribute('aria-expanded')) el.setAttribute('aria-expanded', 'false')
    el.addEventListener('click', (e) => {
      e.preventDefault()
      open(target, el)
    })
    return
  }
  const play = document.createElement('specbook-play') as SpecbookPlay
  play.target = target
  el.append(play)
}

const SELECTOR = ['try', 'flow']
  .map((a) => `[data-specbook-${a}]:not([data-specbook-ready])`)
  .join(',')

const scan = (root: ParentNode) => root.querySelectorAll<HTMLElement>(SELECTOR).forEach(attach)

scan(document)
// SPA docs add content after load
new MutationObserver(() => scan(document)).observe(document.documentElement, {
  childList: true,
  subtree: true,
})
