/** What a proxy will and will not forward. Pure functions, no runtime APIs. */

export interface ProxyPolicy {
  /**
   * The base URL for (env, service); `undefined` means not allowed, so an allow-list is just this
   * function. Not needed where the caller names the URL itself (the extension), which uses `forward`.
   */
  upstream?(env: string, service: string): string | undefined | Promise<string | undefined>
  /** Methods forwarded (default: the usual HTTP methods). */
  methods?: readonly string[]
  /** Largest request body accepted, in bytes (default 25 MB). */
  maxBodyBytes?: number
  /** Give up on the upstream after this many milliseconds (default 60 000). */
  timeoutMs?: number
  /**
   * Allow upstreams on private, loopback and link-local addresses. Off for anything public (a hosted
   * proxy must not reach into a network); on for a developer's own machine and for the extension.
   */
  allowPrivateHosts?: boolean
  /** Refuse requests a browser marks as coming from another site (default true). */
  refuseCrossSite?: boolean
}

export const DEFAULT_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
export const DEFAULT_MAX_BODY = 25 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 60_000

/** Never forwarded: connection plumbing, and what would leak the page's own identity to the API. */
export const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'cookie',
  'origin',
  'referer',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
])

export const isStrippedHeader = (name: string) => {
  const n = name.toLowerCase()
  return STRIPPED_REQUEST_HEADERS.has(n) || n.startsWith('sec-fetch-') || n.startsWith('sec-ch-')
}

/** Headers of a response that must not be copied back (the body has already been decoded). */
export const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie',
])

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return undefined
  const n = m.slice(1).map(Number)
  return n.every((x) => x <= 255) ? n : undefined
}

/** Whether a literal address is one a public proxy must never contact. */
export function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  const v4 = ipv4(h)
  if (v4) {
    const [a, b] = v4 as [number, number, number, number]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    )
  }
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true
    const mapped = /^::ffff:(.+)$/.exec(h)?.[1]
    if (mapped) {
      const dotted = ipv4(mapped)
      if (dotted) return isPrivateAddress(mapped)
      return true // ::ffff:7f00:1 style: refuse rather than parse
    }
    return /^f[cd]/.test(h) || /^fe[89ab]/.test(h)
  }
  return false
}

const PRIVATE_NAMES = /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/i

/** Why an upstream URL is refused, or `undefined` when it is acceptable. */
export function upstreamProblem(
  raw: string,
  opts: { allowPrivateHosts?: boolean } = {},
): string | undefined {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'the upstream is not a valid URL'
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'only http and https are proxied'
  if (u.username || u.password) return 'credentials in a URL are not allowed'
  if (!opts.allowPrivateHosts) {
    if (isPrivateAddress(u.hostname) || PRIVATE_NAMES.test(u.hostname))
      return 'private and local addresses are not reachable through this proxy'
    if (/^\d+$/.test(u.hostname) || /^0x/i.test(u.hostname))
      return 'numeric host forms are not allowed'
  }
  return undefined
}

/**
 * A browser sets `Sec-Fetch-Site` and `Origin` itself; page script cannot. Refusing `cross-site` keeps
 * another website from using a visitor's browser to reach this proxy. A non-browser client sends neither,
 * so it is not affected (it could not be stopped by a header anyway).
 */
export function crossSiteProblem(headers: Headers, url: URL): string | undefined {
  const site = headers.get('sec-fetch-site')
  if (site === 'cross-site') return 'cross-site requests are not accepted'
  const origin = headers.get('origin')
  if (origin && origin !== 'null') {
    try {
      if (new URL(origin).host !== url.host) return 'requests from another origin are not accepted'
    } catch {
      return 'invalid Origin'
    }
  }
  if (origin === 'null') return 'requests from an opaque origin are not accepted'
  return undefined
}
