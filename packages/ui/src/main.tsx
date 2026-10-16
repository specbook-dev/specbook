import { render } from 'preact'
// first: a built project's manifests are filled in before the app module reads them
import 'virtual:specbook/manifests'
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
void (underShell ? Promise.resolve(false) : handleOAuthCallback()).then((handled) => {
  if (!handled) render(<App />, document.getElementById('app') as HTMLElement)
})

if (import.meta.hot) {
  import.meta.hot.on('specbook:registry-changed', () => location.reload())
}
