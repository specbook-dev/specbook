import {
  MissingSecretsError,
  type PreparedRequest,
  secretNames,
  substituteText,
  type Transport,
} from '@specbook/core'
import { originOf, SECRET_PLACEHOLDER, type SecretStore } from './secrets'

/** Who makes the outbound call for a service. */
export type Route = 'direct' | 'proxy' | 'extension'

/**
 * Per service and per request:
 * - a configured proxy (the dev server, or a hosted portal's same-origin route) takes every call;
 * - otherwise a same-origin API is called straight from the page (no extension, cookies just work);
 * - otherwise the extension, when it is installed and enabled, bypasses CORS;
 * - otherwise a direct call, which may be blocked by CORS and says so.
 */
export function routeFor(o: {
  proxy: boolean
  extension: boolean
  baseUrl: string
  pageOrigin?: string
}): Route {
  if (o.proxy) return 'proxy'
  if (o.pageOrigin && originOf(o.baseUrl) === o.pageOrigin) return 'direct'
  if (o.extension) return 'extension'
  return 'direct'
}

/** A config `baseUrl` may be relative (`/api/v1`): it is resolved against the page. */
export function absoluteBase(baseUrl: string, pageHref?: string): string {
  try {
    return new URL(baseUrl, pageHref).toString()
  } catch {
    return baseUrl
  }
}

const names = (req: PreparedRequest): string[] => {
  const out = new Set<string>()
  const scan = (v: unknown) => {
    if (typeof v === 'string') for (const n of secretNames(new TextEncoder().encode(v))) out.add(n)
    else if (Array.isArray(v)) v.forEach(scan)
    else if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
      Object.values(v).forEach(scan)
  }
  scan(req.headers)
  scan(req.query)
  scan(req.body)
  return [...out]
}

/**
 * Puts the values the person typed into a request, bound to the API's origin. A name with no value is
 * left as a placeholder for whoever executes the call (the dev server falls back to its environment
 * files, the extension to its own store); a direct call has no one to fall back on, so it stops there.
 */
export function withPageSecrets(
  inner: Transport,
  o: {
    store: SecretStore
    originFor(service: string): string | undefined
    unresolved: 'keep' | 'fail'
  },
): Transport {
  return (req, signal) => {
    const asked = names(req)
    if (asked.length === 0) return inner(req, signal)
    const origin = o.originFor(req.service)
    const values = new Map<string, string>()
    const missing: string[] = []
    for (const n of asked) {
      const v = origin ? o.store.get(origin, n) : undefined
      if (v === undefined) missing.push(n)
      else values.set(n, v)
    }
    if (missing.length && o.unresolved === 'fail') throw new MissingSecretsError(missing)
    const walk = (v: unknown): unknown =>
      typeof v === 'string'
        ? substituteText(v, values)
        : Array.isArray(v)
          ? v.map(walk)
          : v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
            : v
    return inner(
      {
        ...req,
        headers: walk(req.headers) as typeof req.headers,
        query: walk(req.query) as typeof req.query,
        body: walk(req.body),
      },
      signal,
    )
  }
}

export function routingTransport(o: {
  direct: Transport
  proxy?: Transport
  extension?: Transport
  baseOf(service: string): string
  pageOrigin?: string
}): Transport {
  return (req, signal) => {
    const route = routeFor({
      proxy: !!o.proxy,
      extension: !!o.extension,
      baseUrl: o.baseOf(req.service),
      pageOrigin: o.pageOrigin,
    })
    const send = route === 'proxy' ? o.proxy : route === 'extension' ? o.extension : o.direct
    return (send ?? o.direct)(req, signal)
  }
}

/** Re-exported for the credentials prompt. */
export { SECRET_PLACEHOLDER }
