import {
  type AuthProfile,
  type Encoding,
  type RenderedRequest,
  render,
  type SnippetInput,
  type SnippetLang,
  snippetLangs,
  toSnippet,
} from '@specbook/core'
import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import { engine } from '../runtime'
import { env, version } from '../store'
import { type Draft, requestParts } from './draft'

const LANG_KEY = 'specbook:code-lang'

function savedLang(): SnippetLang {
  try {
    const v = localStorage.getItem(LANG_KEY)
    if (v === 'curl' || v === 'fetch') return v
  } catch {
    /* optional */
  }
  return 'curl'
}

type Applied = { headers?: Record<string, string>; query?: Record<string, string> } | undefined

interface Props {
  service: string
  /** auth profile to apply: its name, `service` for the service's default, or nothing */
  profile?: string
  /** shown as a hint under the sample */
  secured?: boolean
  /** builds the request; keep it stable (useCallback) so values from faker do not change per render */
  make: (base: string, applied: Applied) => SnippetInput
  /** the request as it actually went out, offered as a third view once there is one */
  sent?: ComponentChildren
}

/** cURL / Node fetch tabs with a copy button, for a request described by `make`. */
export function CodeSample({ service, profile, secured, make, sent }: Props) {
  const [view, setView] = useState<SnippetLang | 'sent'>(savedLang)
  const lang: SnippetLang = view === 'sent' ? 'curl' : view
  const [copied, setCopied] = useState(false)
  const [base, setBase] = useState<string>()
  const [applied, setApplied] = useState<Applied>()

  useEffect(() => {
    let live = true
    engine.config(version.value).then((c) => {
      if (!live) return
      const svc = c.services?.[service]
      const urls = svc?.baseUrl ?? {}
      // the environment being used, so a sample for the sandbox points at the sandbox
      setBase(urls[env.value] ?? urls.live ?? Object.values(urls)[0])
      const name = profile === 'service' ? svc?.auth : profile
      setApplied(name ? (c.auth?.[name] as AuthProfile | undefined)?.apply : undefined)
    })
    return () => {
      live = false
    }
  }, [service, profile, env.value])

  const built = useMemo<{ text?: string; error?: string }>(() => {
    try {
      return { text: toSnippet(lang, make(base ?? 'https://api.example.com', applied)) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [make, lang, base, applied])

  const pick = (l: SnippetLang | 'sent') => {
    setView(l)
    if (l === 'sent') return
    try {
      localStorage.setItem(LANG_KEY, l)
    } catch {
      /* optional */
    }
  }

  const copy = async () => {
    if (!built.text) return
    try {
      await navigator.clipboard.writeText(built.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  }

  return (
    <div class="code-sample">
      <div class="code-head">
        <fieldset class="seg" aria-label="Code sample">
          {snippetLangs.map((l) => (
            <button
              type="button"
              aria-pressed={view === l.id}
              class={`seg-btn ${view === l.id ? 'on' : ''}`}
              onClick={() => pick(l.id)}
            >
              {l.label}
            </button>
          ))}
          {sent !== undefined && (
            <button
              type="button"
              aria-pressed={view === 'sent'}
              class={`seg-btn ${view === 'sent' ? 'on' : ''}`}
              onClick={() => pick('sent')}
            >
              Sent
            </button>
          )}
        </fieldset>
        <span class="spacer" />
        {view !== 'sent' && (
          <button type="button" class="btn small" onClick={copy} disabled={!built.text}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {view === 'sent' ? (
        sent
      ) : built.error ? (
        <p class="muted">{built.error}</p>
      ) : (
        <pre class="code-block" part="code">
          <code>{built.text}</code>
        </pre>
      )}
      {view !== 'sent' && secured && (
        <p class="muted small">Secrets are read from environment variables; set them first.</p>
      )}
    </div>
  )
}

interface DraftProps {
  service: string
  method: string
  /** the operation's path template, e.g. /pets/{petId} */
  path: string
  draft: Draft
  encoding: Encoding
  vars: Record<string, string>
  secured?: boolean
  sent?: ComponentChildren
}

/** The sample for the request as currently edited in the panel. */
export function DraftCodeSample({
  service,
  method,
  path,
  draft,
  encoding,
  vars,
  secured,
  sent,
}: DraftProps) {
  const make = useCallback(
    (base: string, applied: Applied): SnippetInput => {
      const parts = requestParts(draft, encoding)
      const raw = {
        path: parts.path ?? {},
        query: parts.query ?? {},
        headers: parts.headers ?? {},
        data: parts.data,
      }
      let r = raw
      try {
        r = render(raw, vars)
      } catch {
        /* a variable is still unset: show the placeholders as they are */
      }
      const url = path.replace(/\{([^}]+)\}/g, (m, n: string) => {
        const v = (r.path as Record<string, unknown>)[n]
        return v === undefined || v === '' ? m : encodeURIComponent(String(v))
      })
      return {
        method,
        url: `${base.replace(/\/+$/, '')}${url}`,
        query: { ...(applied?.query ?? {}), ...(r.query as Record<string, string | string[]>) },
        headers: { ...(applied?.headers ?? {}), ...(r.headers as Record<string, string>) },
        body: r.data,
        encoding,
      }
    },
    [draft, encoding, vars, method, path],
  )
  return (
    <CodeSample
      service={service}
      profile={secured ? 'service' : undefined}
      secured={secured}
      make={make}
      sent={sent}
    />
  )
}

/** The sample for a request a sequence step recorded (placeholders for secrets and session values kept). */
export function StepCodeSample({
  request,
  encoding,
  sent,
}: {
  request: RenderedRequest
  encoding: Encoding
  sent?: ComponentChildren
}) {
  const make = useCallback(
    (base: string, applied: Applied): SnippetInput => ({
      method: request.method,
      url: `${base.replace(/\/+$/, '')}${request.url}`,
      query: { ...(applied?.query ?? {}), ...request.query },
      headers: { ...(applied?.headers ?? {}), ...request.headers },
      body: request.body,
      encoding,
    }),
    [request, encoding],
  )
  return (
    <CodeSample
      service={request.service}
      profile={request.profile}
      secured={!!request.profile}
      make={make}
      sent={sent}
    />
  )
}
