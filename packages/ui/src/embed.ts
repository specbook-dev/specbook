import type { Target } from './embed/panel'
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
button:focus-visible { outline: 2px solid var(--sb-focus-ring); }`

/** The panel (editor, grammars, runner) is a separate chunk fetched on first click. */
async function open(target: Target) {
  const { show } = await import('./embed/panel')
  show(target)
}

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
    b.addEventListener('click', () => open(this.target))
    root.append(b)
  }
}

customElements.define('specbook-play', SpecbookPlay)

function attach(el: HTMLElement) {
  if (el.dataset.specbookReady) return
  el.dataset.specbookReady = ''
  const play = document.createElement('specbook-play') as SpecbookPlay
  play.target = {
    service: el.dataset.specbook || undefined,
    operation: el.dataset.operation,
    sequence: el.dataset.sequence,
    example: el.dataset.example,
    tab: el.dataset.tab === 'docs' ? 'docs' : undefined,
  }
  el.append(play)
}

const scan = (root: ParentNode) =>
  root.querySelectorAll<HTMLElement>('[data-specbook]:not([data-specbook-ready])').forEach(attach)

scan(document)
// SPA docs add content after load
new MutationObserver(() => scan(document)).observe(document.documentElement, {
  childList: true,
  subtree: true,
})
