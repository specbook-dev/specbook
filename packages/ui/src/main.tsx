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
// a sign-in's return leg is handed to the tab that started it; this page then has nothing to draw
void handleOAuthCallback().then((handled) => {
  if (!handled) render(<App />, document.getElementById('app') as HTMLElement)
})

if (import.meta.hot) {
  import.meta.hot.on('specbook:registry-changed', () => location.reload())
}
