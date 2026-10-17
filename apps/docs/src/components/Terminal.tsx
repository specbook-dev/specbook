// A terminal on the page that runs the demo's requests and flows with the same runner and list reporter the CLI uses.
// What it executes is the files the snippets show, loaded when Run is first pressed.

import { useEffect, useRef, useState } from 'preact/hooks'
import envText from '../../demo/.specbook/environments/demo.env?raw'
import config from '../../demo/.specbook/specbook.config'
import { demoReady, onDemoChange, setChaos } from '../../demo/server/client'
import { type Chaos, calm } from '../../demo/server/store'
import { ansiToHtml } from '../lib/ansi'
import { runDemo } from '../lib/run-demo'

const requests = import.meta.glob('../../demo/requests/**/*.req.ts')
const flows = import.meta.glob('../../demo/sequences/*.seq.ts')

/** What the demo API does while a run goes, and the flag that makes it a useful example. */
const CHAOS = {
  calm: { label: 'Working', patch: {}, retries: 0, note: 'the API answers' },
  down: { label: 'API down', patch: { fail: true }, retries: 0, note: 'every request answers 500' },
  wrong: {
    label: 'Wrong data',
    patch: { mutate: true },
    retries: 0,
    note: 'an order comes back changed, which a check on it catches',
  },
  flaky: {
    label: 'Flaky',
    patch: { failNext: 1 },
    retries: 1,
    note: 'one request fails, then it is fine: with --retries 1 the run passes, called flaky',
  },
  missing: {
    label: 'Not found',
    patch: { notFound: true },
    retries: 0,
    note: 'what exists answers 404',
  },
} satisfies Record<string, { label: string; patch: Partial<Chaos>; retries: number; note: string }>

type ChaosId = keyof typeof CHAOS

export interface TerminalProps {
  /** file names without extension, e.g. ['find-pets', 'adopt-pet']; empty runs every request and flow */
  files?: string[]
  /** which conditions to offer, in order; the first is the default */
  chaos?: ChaosId[]
  grep?: string
  version: string
}

const stem = (path: string) =>
  path
    .split('/')
    .pop()
    ?.replace(/\.(req|seq)\.ts$/, '') ?? path

export default function Terminal({ files = [], chaos = ['calm'], grep, version }: TerminalProps) {
  const [mode, setMode] = useState<ChaosId>(chaos[0] ?? 'calm')
  const [out, setOut] = useState('')
  const [running, setRunning] = useState(false)
  const [ready, setReady] = useState<'loading' | 'ready' | 'unsupported' | 'bypassed'>('loading')
  const [copied, setCopied] = useState(false)
  const log = useRef<HTMLPreElement>(null)

  useEffect(() => {
    demoReady().then(setReady)
    return onDemoChange(() => {})
  }, [])
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [out])

  const retries = CHAOS[mode].retries
  const command = [
    'specbook test --env demo',
    grep ? `--grep "${grep}"` : '',
    retries ? `--retries ${retries}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  async function run() {
    setRunning(true)
    let text = `\u001b[2m$ ${command}\u001b[22m\n`
    setOut(text)
    const write = (s: string) => {
      text += s
      setOut(text)
    }
    try {
      await setChaos({ ...calm(), ...CHAOS[mode].patch })
      const wanted = (path: string) => !files.length || files.includes(stem(path))
      const loaders = Object.entries({ ...requests, ...flows }).filter(([p]) => wanted(p))
      const modules = await Promise.all(
        loaders.map(async ([file, load]) => ({
          file: file.replace('../../demo/', ''),
          mod: (await load()) as Record<string, unknown>,
        })),
      )
      const code = await runDemo({
        config,
        modules,
        env: 'demo',
        envText,
        retries,
        grep,
        fetch: (input, init) => fetch(input, init),
        pageHref: location.href,
        version,
        write,
      })
      write(`\n\u001b[2mexit ${code}\u001b[22m\n`)
    } catch (e) {
      write(`\n\u001b[31m${e instanceof Error ? e.message : String(e)}\u001b[39m\n`)
    } finally {
      await setChaos(calm()).catch(() => {})
      setRunning(false)
    }
  }

  const blocked = ready !== 'ready'
  return (
    <div class="term">
      <div class="term-bar">
        <span class="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <code class="term-cmd">{command}</code>
        <span class="grow" />
        <button
          type="button"
          class="chip action"
          onClick={() => {
            navigator.clipboard?.writeText(command).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {chaos.length > 1 && (
        <div
          class="term-chaos"
          role="radiogroup"
          aria-label="What the demo API does during the run"
        >
          {chaos.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              class={`chip action${mode === id ? ' on' : ''}`}
              disabled={running}
              onClick={() => setMode(id)}
            >
              {CHAOS[id].label}
            </button>
          ))}
          <span class="term-note">{CHAOS[mode].note}. This shows the runner, not real uptime.</span>
        </div>
      )}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: ansiToHtml escapes the text and emits only its own spans */}
      <pre
        ref={log}
        class="term-out"
        role="log"
        aria-live="polite"
        aria-label="Output of the run"
        tabIndex={0}
        dangerouslySetInnerHTML={{
          __html: out ? ansiToHtml(out) : '<span class="a-d">Press Run to start.</span>',
        }}
      />
      <div class="term-foot">
        <button type="button" class="btn primary" disabled={running || blocked} onClick={run}>
          {running ? 'Running…' : out ? 'Run again' : 'Run'}
        </button>
        {blocked && (
          <span class="term-note">
            {ready === 'loading'
              ? 'Starting the demo API…'
              : 'The demo API needs a service worker, which this browser is not allowing here.'}
          </span>
        )}
      </div>
    </div>
  )
}
