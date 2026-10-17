// What a page of the docs site uses to talk to the demo API: wait for the service worker that answers it, and read and
// switch its chaos. Browser only.

import type { Chaos } from './store'

export type DemoStatus =
  /** the worker answers /api on this page */
  | 'ready'
  /** the browser has no service workers, or this page may not use them (some private modes) */
  | 'unsupported'
  /** a worker is installed but this page was loaded around it (a hard reload): reload to use the demo API */
  | 'bypassed'

export interface DemoOptions {
  scriptUrl?: string
  /** how long a first visit waits for the worker to take control of the page */
  waitMs?: number
  /** how long installing the worker may take before the page is told it cannot have it */
  installMs?: number
}

let ready: Promise<DemoStatus> | undefined

/** Registers the worker once and says whether the demo API can be used on this page. Never rejects. */
export function demoReady({
  scriptUrl = '/sw.js',
  waitMs = 3000,
  installMs = 10_000,
}: DemoOptions = {}): Promise<DemoStatus> {
  ready ??= (async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported'
    // a page that may not use workers can leave this pending rather than fail, so it is given a time to finish
    const installed = await Promise.race([
      navigator.serviceWorker
        .register(scriptUrl, { scope: '/' })
        .then(() => navigator.serviceWorker.ready)
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), installMs)),
    ])
    if (!installed) return 'unsupported'
    if (navigator.serviceWorker.controller) return 'ready'
    // a first visit: the worker claims the page as it activates, which is announced, and no reload is needed
    await new Promise<void>((done) => {
      const timer = setTimeout(done, waitMs)
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          clearTimeout(timer)
          done()
        },
        { once: true },
      )
    })
    return navigator.serviceWorker.controller ? 'ready' : 'bypassed'
  })()
  return ready
}

const CHANNEL = 'specbook-demo'
const json = { 'content-type': 'application/json' }

const tell = (what: 'chaos' | 'reset') => {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(CHANNEL)
  channel.postMessage(what)
  channel.close()
}

export const getChaos = async (): Promise<Chaos> => (await fetch('/api/_demo/chaos')).json()

/** Switches chaos on or off; every widget on every open page hears of it. */
export async function setChaos(patch: Partial<Chaos>): Promise<Chaos> {
  const next = (await (
    await fetch('/api/_demo/chaos', { method: 'PUT', headers: json, body: JSON.stringify(patch) })
  ).json()) as Chaos
  tell('chaos')
  return next
}

/** Back to the seed data with no chaos. */
export async function resetDemo(): Promise<void> {
  await fetch('/api/_demo/reset', { method: 'POST' })
  tell('reset')
}

/** Calls back when another widget or page changed the demo. Returns a function that stops listening. */
export function onDemoChange(callback: (what: 'chaos' | 'reset') => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (e) => callback(e.data)
  return () => channel.close()
}
