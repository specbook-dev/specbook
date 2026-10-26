// What a script is given in node, for `specbook test` and a bundle: the global `fetch`, and a way to load an SDK's script
// file that runs it in a sandbox standing in for a window. Nothing here may import the Vite loader, the globber or the spec
// tooling: a bundle carries this file.

import { createHash } from 'node:crypto'
import vm from 'node:vm'
import type { ScriptHost } from '@specbook/core/internal'

const ALGORITHMS = { sha256: 'sha256', sha384: 'sha384', sha512: 'sha512' } as const

/** Throws unless the bytes match one of the hashes of an `integrity` value (`sha384-<base64> sha256-<base64>`). */
export function checkIntegrity(url: string, bytes: Uint8Array, integrity: string): void {
  const wanted = integrity
    .split(/\s+/)
    .filter(Boolean)
    .map((h) => [h.slice(0, Math.max(0, h.indexOf('-'))), h.slice(h.indexOf('-') + 1)] as const)
    .filter(([alg]) => alg in ALGORITHMS)
  if (wanted.length === 0)
    throw new Error(
      `The integrity value for ${url} names no hash this host can check (sha256, sha384 or sha512).`,
    )
  const matches = wanted.some(
    ([alg, b64]) =>
      createHash(ALGORITHMS[alg as keyof typeof ALGORITHMS])
        .update(bytes)
        .digest('base64') === b64.split('?')[0],
  )
  if (!matches)
    throw new Error(
      `${url} does not match its integrity hash: it is not the file that was expected.`,
    )
}

/**
 * The web platform a library written for a browser may reach for, beyond what the language has: Node 24 has each of these,
 * and a name it lacks is left out. The DOM is not here on purpose: a file that needs it is a browser script.
 */
const WEB_PLATFORM = [
  'AbortController',
  'AbortSignal',
  'Blob',
  'Event',
  'EventTarget',
  'FormData',
  'Headers',
  'Request',
  'Response',
  'performance',
  'structuredClone',
] as const

export interface NodeScriptHostOptions {
  /** For tests. */
  fetch?: typeof fetch
}

/**
 * The host of a run in node. A script file is run in one sandbox for the whole run, as a page keeps its globals: `window`,
 * `self` and `globalThis` are the sandbox, so the second file of an SDK sees what the first defined. There is no DOM
 * (`document`, `navigator`): a file that needs one is a browser script.
 */
export function nodeScriptHost(o: NodeScriptHostOptions = {}): ScriptHost {
  const doFetch: typeof fetch = o.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const sandbox: Record<string, unknown> = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    atob,
    btoa,
    crypto: globalThis.crypto,
    fetch: doFetch,
  }
  for (const name of WEB_PLATFORM)
    if (name in globalThis) sandbox[name] = (globalThis as Record<string, unknown>)[name]
  sandbox.window = sandbox.self = sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  const loaded = new Map<string, Promise<void>>()

  return {
    runtime: 'node',
    fetch: doFetch,
    loadScript: async (url, opts) => {
      const load = async () => {
        const res = await doFetch(url)
        if (!res.ok) throw new Error(`Could not load ${url}: the server answered ${res.status}.`)
        const bytes = new Uint8Array(await res.arrayBuffer())
        if (opts?.integrity) checkIntegrity(url, bytes, opts.integrity)
        try {
          vm.runInContext(new TextDecoder().decode(bytes), context, {
            filename: url,
            timeout: 30_000,
          })
        } catch (e) {
          // an error made inside the sandbox is of that realm's Error, which `instanceof Error` does not know
          const message = (e as { message?: unknown } | undefined)?.message
          throw new Error(
            `Could not run ${url}: ${typeof message === 'string' ? message : String(e)}`,
          )
        }
      }
      let pending: Promise<void>
      if (opts?.once === false) {
        // runs again in the same sandbox, and neither reads nor fills the record of what was loaded
        pending = load()
      } else {
        let cached = loaded.get(url)
        if (!cached) {
          cached = load()
          // a file that failed may be tried again, as in a page
          cached.catch(() => loaded.delete(url))
          loaded.set(url, cached)
        }
        pending = cached
      }
      await pending
      if (!opts?.global) return undefined
      const value = sandbox[opts.global]
      if (value === undefined)
        throw new Error(`${url} loaded, but it did not define \`${opts.global}\`.`)
      return value
    },
  }
}
