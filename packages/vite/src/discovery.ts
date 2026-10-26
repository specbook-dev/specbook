import { parseDiscovery } from '@specbook/core/internal'

const FETCH_TIMEOUT_MS = 5_000

/**
 * Learns, on the server, where an OpenID Connect provider's token endpoint is. The page needs the proxy to
 * forward its code exchange there, and the proxy only forwards to origins it was told about by the
 * project's own config; a discovery document is the config's pointer to that origin. Successes are kept
 * for the life of the dev server; a failure is not retried for a short while, so a provider that is down
 * costs one slow request, not one per call.
 */
export function createDiscovery(
  opts: {
    fetch?: typeof fetch
    retryAfterMs?: number
    now?: () => number
    warn?: (message: string) => void
  } = {},
) {
  const f = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const retryAfter = opts.retryAfterMs ?? 30_000
  const found = new Map<string, string>()
  const failedAt = new Map<string, number>()
  const inFlight = new Map<string, Promise<string | undefined>>()

  async function look(url: string): Promise<string | undefined> {
    try {
      const res = await f(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`answered ${res.status}`)
      const origin = new URL(parseDiscovery(await res.json()).tokenUrl).origin
      found.set(url, origin)
      failedAt.delete(url)
      return origin
    } catch (e) {
      failedAt.set(url, now())
      opts.warn?.(
        `Could not read the OpenID Connect discovery document at ${url} (${e instanceof Error ? e.message : String(e)}). Sign in is unavailable until it can; pasting a token still works.`,
      )
      return undefined
    }
  }

  /** The origin of the provider's token endpoint, or `undefined` when discovery has failed. */
  return function tokenOrigin(url: string): Promise<string | undefined> {
    const known = found.get(url)
    if (known) return Promise.resolve(known)
    const failed = failedAt.get(url)
    if (failed !== undefined && now() - failed < retryAfter) return Promise.resolve(undefined)
    let pending = inFlight.get(url)
    if (!pending) {
      pending = look(url).finally(() => inFlight.delete(url))
      inFlight.set(url, pending)
    }
    return pending
  }
}
