// What a script is given in a page: a `fetch` that goes through the browser extension when a site needs it, a way to load
// an SDK's script file, and the container the panel makes for it. No project code is loaded here; the host is built for
// each run, and `loadScript` remembers what it loaded for as long as the page lives.

import type { ScriptHost } from '@specbook/core/internal'
import { corsHint, READS, willPreflight } from './cors'
import { type ExtensionBridge, extensionFetch, WireError } from './extension'

export interface BrowserScriptHostOptions {
  /** The extension, when this page has one. */
  bridge?: ExtensionBridge
  level?: 'ready' | 'outdated'
  pageOrigin?: string
  /** Makes the container a script renders into; the panel supplies it. */
  mount?: ScriptHost['mount']
  /** For tests: the page's own `fetch` and `document`. */
  fetch?: typeof fetch
  document?: Pick<Document, 'createElement' | 'head'>
}

const addressOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

/** The origin a call goes to; a relative address is the page's own. */
function targetOrigin(input: Parameters<typeof fetch>[0], pageOrigin: string | undefined) {
  try {
    return new URL(addressOf(input), pageOrigin ?? globalThis.location?.href).origin
  } catch {
    return undefined
  }
}

/**
 * The `fetch` of a script in a page. The page's own origin is called straight. Another origin goes through the extension
 * when it is there, and is tried from the page first when the person has not allowed it yet and a browser would send the
 * call anyway (a read, or a request the API is asked about first), as a request step does. Without the extension a blocked
 * call fails with the hint that offers it. A script never goes through the dev server's proxy: that only knows the project's
 * own APIs, which a request step calls, with their credentials.
 */
export function scriptFetch(o: BrowserScriptHostOptions): typeof fetch {
  const own: typeof fetch = o.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const viaExtension = o.bridge && o.level === 'ready' ? extensionFetch(o.bridge) : undefined

  const blocked = (e: unknown, origin: string | undefined): never => {
    if (!(e instanceof TypeError)) throw e
    const hint = corsHint(origin, o.pageOrigin, o.level)
    throw Object.assign(
      new Error(
        `The browser could not reach ${origin ?? 'that address'}. The site probably does not allow calls from this page (CORS). The Specbook browser extension can make the call.`,
      ),
      hint ? { hint } : {},
    )
  }

  return async (input, init) => {
    const origin = targetOrigin(input, o.pageOrigin)
    if (!origin || origin === o.pageOrigin) return own(input, init)
    if (!viaExtension) {
      try {
        return await own(input, init)
      } catch (e) {
        return blocked(e, origin)
      }
    }
    try {
      return await viaExtension(input, init)
    } catch (e) {
      const method = (
        init?.method ??
        (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
      ).toUpperCase()
      const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries())
      if (
        !(e instanceof WireError) ||
        e.code !== 'not-allowed' ||
        !(READS.has(method) || willPreflight({ method, encoding: 'text', headers }))
      )
        throw e
      try {
        return await own(input, init)
      } catch (direct) {
        // the browser blocked that too: what the person can fix is the extension's refusal, not a bare network error
        if (direct instanceof TypeError) throw e
        throw direct
      }
    }
  }
}

/** Script files already put in the page, by address: a second Run does not run an SDK's file a second time. */
const loaded = new Map<string, Promise<void>>()
/** The tag of the last `once: false` load of an address, taken down when the next one comes so the page keeps one. */
const again = new Map<string, HTMLScriptElement>()

/** Forgets what was loaded (tests). */
export const resetLoadedScripts = () => {
  loaded.clear()
  again.clear()
}

function scriptLoader(o: BrowserScriptHostOptions): NonNullable<ScriptHost['loadScript']> {
  return async (url, opts) => {
    const doc = o.document ?? globalThis.document
    const inject = (onFail: () => void) =>
      new Promise<void>((resolve, reject) => {
        const tag = doc.createElement('script')
        tag.src = url
        tag.async = true
        if (opts?.integrity) {
          tag.integrity = opts.integrity
          tag.crossOrigin = 'anonymous'
        }
        tag.onload = () => resolve()
        tag.onerror = () => {
          // a file that failed may be tried again: the person may have fixed the address, the network or the page's policy
          onFail()
          tag.remove?.()
          reject(
            new Error(
              `Could not load ${url}. The address may be wrong, the site may be down, or this page's Content-Security-Policy (script-src) may not allow it${opts?.integrity ? ', or the file does not match its integrity hash' : ''}.`,
            ),
          )
        }
        if (opts?.once === false) {
          again.get(url)?.remove?.()
          again.set(url, tag)
        }
        // the page's head, not the panel: a script defines its globals on the window wherever it is put, and the project
        // embed's panel is inside a shadow root that has no place for one
        doc.head.append(tag)
      })
    let pending: Promise<void>
    if (opts?.once === false) {
      // loads again, and neither reads nor fills the record of what was loaded
      pending = inject(() => {})
    } else {
      let cached = loaded.get(url)
      if (!cached) {
        cached = inject(() => loaded.delete(url))
        loaded.set(url, cached)
      }
      pending = cached
    }
    await pending
    if (!opts?.global) return undefined
    const value = (globalThis as Record<string, unknown>)[opts.global]
    if (value === undefined)
      throw new Error(`${url} loaded, but it did not define \`${opts.global}\` on the page.`)
    return value
  }
}

export function browserScriptHost(o: BrowserScriptHostOptions = {}): ScriptHost {
  return {
    runtime: 'browser',
    fetch: scriptFetch(o),
    loadScript: scriptLoader(o),
    mount: o.mount,
  }
}
