import { loadManifests } from 'virtual:specbook/registry'
import { render } from 'preact'
import { App } from './app'
import { handleOAuthCallback } from './oauth-callback'
import { applyTheme } from './theme'
import 'prism-code-editor/layout.css'
import 'prism-code-editor/autocomplete.css'
import 'prism-code-editor/autocomplete-icons.css'
import './styles/tokens.css'
import './styles/app.css'
import './styles/panel.css'

applyTheme()
// A sign-in's return leg is handed to the tab that started it; this page then has nothing to draw. Under the
// viewer shell or an embed (which import this) that was settled before they got here, and running it again
// would strip a host page's own `?code=&state=` that the embed deliberately left alone.
const underShell =
  (globalThis as { __SPECBOOK_VIEWER__?: unknown }).__SPECBOOK_VIEWER__ !== undefined
void (underShell ? Promise.resolve(false) : handleOAuthCallback()).then(async (handled) => {
  if (handled) return
  // a built project starts with its services' lists not loaded: fetch them, then draw the app. The app's own code
  // is part of this page's static imports, so it loads alongside, not after (an embed fetches only the lists it needs)
  await loadManifests()
  render(<App />, document.getElementById('app') as HTMLElement)
})

if (import.meta.hot) {
  import.meta.hot.on('specbook:registry-changed', () => location.reload())
}
