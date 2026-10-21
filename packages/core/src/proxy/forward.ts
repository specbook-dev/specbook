import {
  crossSiteProblem,
  DEFAULT_MAX_BODY,
  DEFAULT_METHODS,
  DEFAULT_TIMEOUT_MS,
  isStrippedHeader,
  type ProxyPolicy,
  STRIPPED_RESPONSE_HEADERS,
  upstreamProblem,
} from './policy'
import { secretNames, secretNamesIn, substituteBytes, substituteText } from './substitute'

/** What happened, without any request or response content. */
export interface ProxyEvent {
  env?: string
  service?: string
  method: string
  host?: string
  status: number
  ms: number
  bytesIn: number
  outcome: 'ok' | 'refused' | 'missing-secrets' | 'upstream-error' | 'timeout'
}

/** Why `forward` itself said no, as opposed to the upstream API's own answer (see `markRefusals`). */
export type Refusal =
  | 'blocked'
  | 'too-large'
  | 'missing-secrets'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'aborted'

/** Set on a response `forward` produced itself, when `markRefusals` is on. */
export const REFUSAL_HEADER = 'x-specbook-refused'

export interface ProxyDeps {
  policy: ProxyPolicy
  /**
   * Tag the responses `forward` makes itself (a refusal, a missing secret, a timeout) with `REFUSAL_HEADER`,
   * so a caller that turns them into messages can tell them from the upstream API's own 403, 413, 502 or
   * 504. Off for the dev proxy, whose caller sees plain HTTP.
   */
  markRefusals?: boolean
  /** Secret by name; `undefined` when this proxy does not hold it. */
  lookup?(
    name: string,
    ctx: { env?: string; service?: string },
  ): string | undefined | Promise<string | undefined>
  fetch?: typeof fetch
  onEvent?(e: ProxyEvent): void
}

export interface ProxyTarget {
  env?: string
  service?: string
  /** Absolute upstream URL, query included. */
  url: string
}

const json = (status: number, body: unknown, extra?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  })

/** Everything after the route is known: policy, secrets, the outbound call, the reply. */
export async function forward(
  req: Request,
  target: ProxyTarget,
  deps: ProxyDeps,
): Promise<Response> {
  const started = Date.now()
  const { policy } = deps
  let bytesIn = 0
  const done = (res: Response, outcome: ProxyEvent['outcome']) => {
    deps.onEvent?.({
      env: target.env,
      service: target.service,
      method: req.method,
      host: safeHost(target.url),
      status: res.status,
      ms: Date.now() - started,
      bytesIn,
      outcome,
    })
    return res
  }

  // a response `forward` makes itself; tagged only when the caller asked, so it can be told from the API's
  const refuse = (
    status: number,
    error: string,
    code: Refusal,
    outcome: ProxyEvent['outcome'] = 'refused',
  ) =>
    done(
      json(status, { error }, deps.markRefusals ? { [REFUSAL_HEADER]: code } : undefined),
      outcome,
    )

  if (policy.refuseCrossSite !== false) {
    const why = crossSiteProblem(req.headers, new URL(req.url))
    if (why) return refuse(403, why, 'blocked')
  }
  const methods = policy.methods ?? DEFAULT_METHODS
  if (!methods.includes(req.method.toUpperCase()))
    return refuse(405, `${req.method} is not allowed`, 'blocked')
  const bad = upstreamProblem(target.url, { allowPrivateHosts: policy.allowPrivateHosts })
  if (bad) return refuse(403, bad, 'blocked')

  // the request, as bytes
  const max = policy.maxBodyBytes ?? DEFAULT_MAX_BODY
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > max) return refuse(413, 'request body too large', 'too-large')
  let body: Uint8Array | undefined
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    body = new Uint8Array(await req.arrayBuffer())
    bytesIn = body.length
    if (body.length > max) return refuse(413, 'request body too large', 'too-large')
  }

  // secrets: names from headers, query and body, resolved by the injected lookup
  const headerPairs = [...req.headers.entries()].filter(([k]) => !isStrippedHeader(k))
  const asked = new Set<string>()
  for (const [, v] of headerPairs) for (const n of secretNamesIn(v)) asked.add(n)
  const url = new URL(target.url)
  // a placeholder in a query string may be written literally or percent-encoded
  const plainQuery = url.search.replace(/%7B/gi, '{').replace(/%7D/gi, '}').replace(/%20/g, ' ')
  for (const n of secretNamesIn(plainQuery)) asked.add(n)
  if (body) for (const n of secretNames(body)) asked.add(n)
  const values = new Map<string, string>()
  const missing: string[] = []
  for (const name of asked) {
    const v = await deps.lookup?.(name, { env: target.env, service: target.service })
    if (v === undefined) missing.push(name)
    else values.set(name, v)
  }
  if (missing.length)
    return refuse(
      400,
      `Missing secrets: ${missing.join(', ')}`,
      'missing-secrets',
      'missing-secrets',
    )

  const headers = new Headers()
  for (const [k, v] of headerPairs) headers.set(k, substituteText(v, values))
  if (secretNamesIn(plainQuery).length > 0) {
    // a value goes into a query string percent-encoded, so `&` or `+` in a key cannot split it
    const encoded = new Map([...values].map(([k, v]) => [k, encodeURIComponent(v)]))
    url.search = substituteText(plainQuery, encoded)
  }

  const ctl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctl.abort()
  }, policy.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  if (req.signal?.aborted) ctl.abort()
  req.signal?.addEventListener('abort', () => ctl.abort())
  try {
    const upstream = await (deps.fetch ?? fetch)(url.toString(), {
      method: req.method,
      headers,
      body: body ? (substituteBytes(body, values) as BodyInit) : undefined,
      // a redirect is the caller's to follow: following one could leave the allow-listed host
      redirect: 'manual',
      // never the browser's cookies for the upstream: a caller that is a browser extension would otherwise
      // send the person's own session to an API they only meant to call with a key
      credentials: 'omit',
      signal: ctl.signal,
    })
    // a browser reports a manual redirect as an opaque response with status 0 (no status, no Location);
    // Node gives the real 3xx, which goes through below
    if (upstream.type === 'opaqueredirect')
      return refuse(
        502,
        'The API answered with a redirect, which is not followed here. Use the address it redirects to.',
        'redirect',
        'upstream-error',
      )
    const out = new Headers()
    upstream.headers.forEach((v, k) => {
      if (!STRIPPED_RESPONSE_HEADERS.has(k.toLowerCase())) out.set(k, v)
    })
    return done(new Response(upstream.body, { status: upstream.status, headers: out }), 'ok')
  } catch (e) {
    if (timedOut) return refuse(504, 'the upstream timed out', 'timeout', 'timeout')
    if (ctl.signal.aborted) return refuse(499, 'the request was aborted', 'aborted')
    return refuse(502, e instanceof Error ? e.message : String(e), 'network', 'upstream-error')
  } finally {
    clearTimeout(timer)
  }
}

function safeHost(url: string) {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/** `<mount>/<env>/<service>/<rest>`; `undefined` when the URL is not under `mount`. */
export function parseRoute(
  pathname: string,
  mount: string,
): { env: string; service: string; rest: string } | undefined {
  const base = mount.replace(/\/+$/, '')
  if (!pathname.startsWith(`${base}/`)) return undefined
  const m = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(pathname.slice(base.length))
  if (!m) return undefined
  return { env: m[1] as string, service: m[2] as string, rest: m[3] ?? '/' }
}

export interface RouteDeps extends ProxyDeps {
  /** Where the proxy is mounted, e.g. `/__specbook/proxy`. */
  mount: string
}

/**
 * The URL-addressed proxy: `<mount>/<env>/<service>/<path>`. Returns `undefined` for URLs that are not
 * its own, so it can sit in a middleware chain.
 */
export async function handleProxy(req: Request, deps: RouteDeps): Promise<Response | undefined> {
  const url = new URL(req.url)
  const route = parseRoute(url.pathname, deps.mount)
  if (!route) return undefined
  const base = await deps.policy.upstream?.(route.env, route.service)
  if (!base)
    return json(404, {
      error: `No baseUrl for service "${route.service}" in env "${route.env}"`,
    })
  return forward(
    req,
    {
      env: route.env,
      service: route.service,
      url: `${base.replace(/\/+$/, '')}${route.rest}${url.search}`,
    },
    deps,
  )
}
