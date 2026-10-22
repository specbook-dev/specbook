import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import markUrl from '../assets/mark.svg'
import { handleOAuthCallback } from '../oauth-callback'
import { applyTheme } from '../theme'
import { type OpenFailure, SpecWorker } from './client'
import { mountOpened } from './mount'
import { Opening } from './Opening'
import type { OpenResult, Source } from './protocol'
import { recentSpecs, rememberSpec } from './recent'
import { rawGithub, softEncode, unreadableWhy } from './share'
import { loadUpload, saveUpload } from './uploads'
import 'prism-code-editor/layout.css'
import 'prism-code-editor/autocomplete.css'
import 'prism-code-editor/autocomplete-icons.css'
import '../styles/tokens.css'
import '../styles/app.css'
import '../styles/panel.css'
import './viewer.css'

const EXAMPLES: { label: string; url: string }[] = [
  { label: 'Petstore', url: 'https://petstore3.swagger.io/api/v3/openapi.json' },
  { label: 'httpbin (live requests work)', url: 'https://httpbin.org/spec.json' },
  {
    label: 'Stripe (form-encoded requests)',
    url: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
  },
  {
    label: 'OpenAI',
    url: 'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml',
  },
  {
    label: 'GitHub (large)',
    url: 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
  },
]

// a stored light or dark choice applies before anything is drawn, as the app itself would
applyTheme()

const root = document.getElementById('app') as HTMLElement
const params = new URLSearchParams(location.search)
// a link that names its document goes straight to opening it: show the app's shape, not the picker
const autostart = params.has('spec') || params.has('upload')

const specUrl = (u: string) => `${location.origin}${location.pathname}?spec=${softEncode(u)}`

// framed on another site: the host chose the document, and the page around it is theirs
const framed = window.top !== window

/**
 * Why an address could not be read, in words, when the page can tell: it is a file on the visitor's own machine, or a
 * private address that a page served from the public internet cannot reach. A copy of the viewer served from a private
 * address (a laptop, an intranet) reaches such addresses as well as anything, so it says nothing of the kind.
 */
const LOCAL = 'That address is on your own machine or network, which a hosted page cannot reach.'
function whyUnreadable(address: string): { message: string; code: 'local' } | undefined {
  const here = unreadableWhy(location.origin) === 'cors'
  const file = /^file:/i.test(address)
  return file || (here && unreadableWhy(address) === 'local')
    ? { message: LOCAL, code: 'local' }
    : undefined
}

/** The hosted site's landing page: only where the build declares one, and never inside another site's frame. */
function hostedHome(): string | undefined {
  if (framed) return undefined
  return (
    document.querySelector<HTMLMetaElement>('meta[name="specbook-home"]')?.content.trim() ||
    undefined
  )
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading'; what: string; progress?: string }
  | { kind: 'error'; message: string; code?: OpenFailure['code'] | 'local' }
  | { kind: 'base'; open: OpenResult; apply(base: string | undefined): void }

function Picker({ initial }: { initial: Phase }) {
  const [phase, setPhase] = useState<Phase>(initial)
  const [url, setUrl] = useState(params.get('spec') ?? '')
  const [text, setText] = useState('')
  const [over, setOver] = useState(false)
  const worker = useRef<SpecWorker | undefined>(undefined)

  const start = async (source: Source, label: string, remember?: string) => {
    worker.current ??= new SpecWorker()
    setPhase({ kind: 'loading', what: label })
    const { promise } = worker.current.open(source, (progress) =>
      setPhase({ kind: 'loading', what: label, progress }),
    )
    try {
      const result = await promise
      const finish = async (baseUrl?: string) => {
        if (remember) rememberSpec(remember)
        // the app renders over this one: clearing first would leave a blank page while its code loads
        await mountOpened({ result, worker: worker.current as SpecWorker, source, baseUrl })
      }
      if (result.needsBaseUrl)
        setPhase({ kind: 'base', open: result, apply: (b) => void finish(b) })
      else await finish()
    } catch (e) {
      const f = e as OpenFailure
      // a fetch that failed for an address a hosted page cannot reach is that, not "the server may not allow it"
      const why = f.code === 'cors' && source.kind === 'url' ? whyUnreadable(source.url) : undefined
      if (why) return setPhase({ kind: 'error', ...why })
      setPhase({ kind: 'error', message: f.message, code: f.code })
    }
  }

  const openUrl = (u: string) => {
    const clean = rawGithub(u.trim())
    if (!clean) return
    if (!/^https?:\/\//i.test(clean)) {
      const why = whyUnreadable(clean)
      return setPhase(
        why
          ? { kind: 'error', ...why }
          : { kind: 'error', message: 'Enter an address starting with http:// or https://' },
      )
    }
    history.replaceState(null, '', specUrl(clean))
    void start({ kind: 'url', url: clean }, clean, clean)
  }

  const openText = async (name: string, body: string) => {
    const id = await saveUpload(name, body)
    if (id) history.replaceState(null, '', `${location.pathname}?upload=${id}`)
    void start({ kind: 'text', text: body, name }, name)
  }

  useEffect(() => {
    const s = params.get('spec')
    const up = params.get('upload')
    if (s) openUrl(s)
    else if (up)
      void loadUpload(up).then((u) =>
        u
          ? start({ kind: 'text', text: u.text, name: u.name }, u.name)
          : setPhase({
              kind: 'error',
              message: 'That uploaded document is no longer stored in this browser.',
            }),
      )
  }, [])

  const home = hostedHome()
  const busy = phase.kind === 'loading'
  if (autostart && (phase.kind === 'idle' || phase.kind === 'loading'))
    return (
      <Opening
        what={params.get('spec') ?? 'your uploaded document'}
        progress={phase.kind === 'loading' ? phase.progress : undefined}
      />
    )
  // a failure to open the host's document is the host's to fix: say what went wrong and nothing of the
  // viewer's own page (an address box, paste, examples) for the host's visitors to wander into
  if (framed && params.has('spec') && phase.kind === 'error')
    return (
      <main class="vw">
        <div class="vw-card vw-bare">
          <div class="vw-error" role="alert">
            {phase.message}
          </div>
        </div>
      </main>
    )
  return (
    <main class="vw">
      <div class="vw-card">
        <header class="vw-brand">
          <img src={markUrl} alt="" width="32" height="32" />
          <h1>Specbook</h1>
        </header>
        <p>
          Open any OpenAPI or Swagger document. It is read in your browser; nothing is uploaded.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            openUrl(url)
          }}
        >
          <input
            type="url"
            placeholder="https://example.com/openapi.json"
            aria-label="Address of an OpenAPI or Swagger document"
            value={url}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
            disabled={busy}
          />
          <button type="submit" class="btn primary" disabled={busy}>
            Open
          </button>
        </form>

        {phase.kind === 'loading' && (
          <p class="vw-progress" role="status">
            {phase.progress ?? 'Opening…'}
          </p>
        )}

        {phase.kind === 'error' && (
          <div class="vw-error" role="alert">
            {phase.message}
            {(phase.code === 'cors' || phase.code === 'local') && (
              <> Paste the document below or drop the file instead; it works the same.</>
            )}
          </div>
        )}

        {phase.kind === 'base' && <BasePrompt onApply={phase.apply} title={phase.open.title} />}

        <section
          class={`vw-drop ${over ? 'over' : ''}`}
          aria-label="Drop a document here"
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={async (e) => {
            e.preventDefault()
            setOver(false)
            const f = e.dataTransfer?.files?.[0]
            if (f) await openText(f.name, await f.text())
          }}
        >
          Drop a file here, or{' '}
          <label class="link">
            choose one
            <input
              type="file"
              accept=".json,.yaml,.yml,application/json"
              hidden
              onChange={async (e) => {
                const f = (e.target as HTMLInputElement).files?.[0]
                if (f) await openText(f.name, await f.text())
              }}
            />
          </label>
        </section>

        <section class="vw-paste">
          <p class="vw-paste-title">Or paste the document</p>
          <textarea
            aria-label="OpenAPI or Swagger document text"
            placeholder="{ &quot;openapi&quot;: &quot;3.0.0&quot;, … }"
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          />
          <div>
            <button
              type="button"
              class="btn primary"
              disabled={busy || text.trim() === ''}
              onClick={() => void openText('pasted document', text)}
            >
              Open pasted document
            </button>
          </div>
        </section>

        <section>
          <p>Try one</p>
          <ul class="vw-chips">
            {EXAMPLES.map((x) => (
              <li>
                <button type="button" class="vw-chip" onClick={() => openUrl(x.url)}>
                  {x.label}
                </button>
              </li>
            ))}
          </ul>
        </section>

        {recentSpecs().length > 0 && (
          <section>
            <p>Recent</p>
            <ul class="vw-recent">
              {recentSpecs().map((u) => (
                <li>
                  <button type="button" class="link" title={u} onClick={() => openUrl(u)}>
                    {u}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {home && (
          <footer class="vw-foot">
            <a href={home}>What is Specbook?</a>
          </footer>
        )}
      </div>
    </main>
  )
}

function BasePrompt({
  onApply,
  title,
}: {
  onApply(base: string | undefined): void
  title: string
}) {
  const [base, setBase] = useState('')
  return (
    <form
      class="vw-base"
      onSubmit={(e) => {
        e.preventDefault()
        if (/^https?:\/\//i.test(base.trim())) onApply(base.trim().replace(/\/$/, ''))
      }}
    >
      <p>
        This document gives its server as a relative address. Enter where the API is to make live
        calls, or continue with mock data only.
      </p>
      <input
        type="url"
        placeholder="https://api.example.com"
        aria-label={`Base URL for ${title}`}
        value={base}
        onInput={(e) => setBase((e.target as HTMLInputElement).value)}
      />
      <button type="submit" class="btn primary">
        Use this base URL
      </button>
      <button type="button" class="link" onClick={() => onApply(undefined)}>
        Continue with mock data
      </button>
    </form>
  )
}

// a sign-in's return leg lands on this page too: hand it to the tab that started it, draw nothing here
void handleOAuthCallback().then((handled) => {
  if (!handled) render(<Picker initial={{ kind: 'idle' }} />, root)
})
