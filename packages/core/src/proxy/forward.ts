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

export interface ProxyDeps {
  policy: ProxyPolicy
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

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
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

  if (policy.refuseCrossSite !== false) {
    const why = crossSiteProblem(req.headers, new URL(req.url))
    if (why) return done(json(403, { error: why }), 'refused')
  }
  const methods = policy.methods ?? DEFAULT_METHODS
  if (!methods.includes(req.method.toUpperCase()))
    return done(json(405, { error: `${req.method} is not allowed` }), 'refused')
  const bad = upstreamProblem(target.url, { allowPrivateHosts: policy.allowPrivateHosts })
  if (bad) return done(json(403, { error: bad }), 'refused')

  // the request, as bytes
  const max = policy.maxBodyBytes ?? DEFAULT_MAX_BODY
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > max) return done(json(413, { error: 'request body too large' }), 'refused')
  let body: Uint8Array | undefined
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    body = new Uint8Array(await req.arrayBuffer())
    bytesIn = body.length
    if (body.length > max) return done(json(413, { error: 'request body too large' }), 'refused')
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
    return done(json(400, { error: `Missing secrets: ${missing.join(', ')}` }), 'missing-secrets')

  const headers = new Headers()
  for (const [k, v] of headerPairs) headers.set(k, substituteText(v, values))
  if (secretNamesIn(plainQuery).length > 0) {
    // a value goes into a query string percent-encoded, so `&` or `+` in a key cannot split it
    const encoded = new Map([...values].map(([k, v]) => [k, encodeURIComponent(v)]))
    url.search = substituteText(plainQuery, encoded)
  }

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), policy.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  req.signal?.addEventListener('abort', () => ctl.abort())
  try {
    const upstream = await (deps.fetch ?? fetch)(url.toString(), {
      method: req.method,
      headers,
      body: body ? (substituteBytes(body, values) as BodyInit) : undefined,
      // a redirect is the caller's to follow: following one could leave the allow-listed host
      redirect: 'manual',
      signal: ctl.signal,
    })
    const out = new Headers()
    upstream.headers.forEach((v, k) => {
      if (!STRIPPED_RESPONSE_HEADERS.has(k.toLowerCase())) out.set(k, v)
    })
    return done(new Response(upstream.body, { status: upstream.status, headers: out }), 'ok')
  } catch (e) {
    if (ctl.signal.aborted) return done(json(504, { error: 'the upstream timed out' }), 'timeout')
    return done(json(502, { error: e instanceof Error ? e.message : String(e) }), 'upstream-error')
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
