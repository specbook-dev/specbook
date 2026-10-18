/**
 * `specbook.js`: a page that already serves an API's spec (a framework's docs route) loads this to get the
 * viewer, on its own origin, with no CORS and with the visitor's cookies.
 *
 *   <div id="app"></div>
 *   <script type="application/json" id="specbook-config">{"spec": "/v3/api-docs"}</script>
 *   <script type="module" src="https://ui.specbook.dev/v1/specbook.js"></script>
 *
 * The script takes the page over (it owns the document, as `/docs` does). `spec` may be relative.
 * `baseUrl` gives the API address when the document has none, `target` names another container, and
 * `defaultEnv` (`"live"` or the name of a server) picks the environment shown first instead of `mock`.
 */
import { handleOAuthCallback } from '../oauth-callback'
import { SpecWorker } from './client'
import { mountOpened } from './mount'

interface EmbedConfig {
  spec?: string
  baseUrl?: string
  target?: string
  defaultEnv?: string
}

function readConfig(): EmbedConfig {
  const el = document.getElementById('specbook-config')
  if (el?.textContent) {
    try {
      return JSON.parse(el.textContent) as EmbedConfig
    } catch {
      /* fall through to the script's own attributes */
    }
  }
  const script = document.querySelector<HTMLScriptElement>('script[src$="specbook.js"][data-spec]')
  return {
    spec: script?.dataset.spec,
    baseUrl: script?.dataset.baseUrl,
    defaultEnv: script?.dataset.defaultEnv,
  }
}

function container(sel?: string): HTMLElement {
  const found = sel ? document.querySelector<HTMLElement>(sel) : document.getElementById('app')
  if (found) return found
  const made = document.createElement('div')
  made.id = 'app'
  document.body.append(made)
  return made
}

const say = (el: HTMLElement, text: string, error = false) => {
  el.textContent = text
  el.style.cssText = `font:16px system-ui,sans-serif;padding:24px;color:${error ? '#b42318' : '#5b6270'}`
}

async function start() {
  // A sign-in's popup comes back to this page, so the viewer is what has to hand the code on. The address
  // is left alone unless a viewer tab claims it: the page is the host's, and its `?code=&state=` may be
  // the host application's own sign-in.
  if (await handleOAuthCallback({ stripWhenUnclaimed: false })) return
  const cfg = readConfig()
  const target = container(cfg.target)
  if (!cfg.spec)
    return say(target, 'Specbook: no spec was given (set "spec" in #specbook-config).', true)
  let url: string
  try {
    url = new URL(cfg.spec, location.href).toString()
  } catch {
    return say(target, `Specbook: "${cfg.spec}" is not a valid address.`, true)
  }
  say(target, 'Loading the API…')
  const worker = new SpecWorker()
  try {
    const result = await worker.open({ kind: 'url', url }).promise
    target.textContent = ''
    target.removeAttribute('style')
    await mountOpened({
      result,
      worker,
      source: { kind: 'url', url },
      baseUrl: cfg.baseUrl,
      defaultEnv: typeof cfg.defaultEnv === 'string' ? cfg.defaultEnv : undefined,
      shareable: false,
      setTitle: false,
    })
  } catch (e) {
    say(target, `Specbook: ${e instanceof Error ? e.message : String(e)}`, true)
  }
}

void start()
