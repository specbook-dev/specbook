import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleProxy as proxy } from '@specbook/core'

/** Where one environment's calls may go, worked out on the server from the project's config and files. */
export interface EnvironmentAddresses {
  /** each service's base URL in this environment */
  services: Record<string, string | undefined>
  /**
   * Origin of each OAuth profile's token endpoint. A sign-in exchanges its code through
   * `<mount>/<env>/auth:<profile>/…`; the page chooses the path, never the host.
   */
  tokenOrigins: Record<string, string>
  /**
   * Origin of each OpenID Connect profile's discovery document, addressed as
   * `<mount>/<env>/discovery:<profile>/…` (the token endpoint may be on another host).
   */
  discoveryOrigins: Record<string, string>
}

export interface ProxyConfig {
  secretNames: Record<string, { env?: string }>
  /** The addresses for `env`; empty for an environment the project does not have. */
  resolve(env: string): Promise<EnvironmentAddresses>
}

/** The reserved service name a sign-in's token exchange is addressed to. */
export const AUTH_SERVICE_PREFIX = 'auth:'
/** The reserved service name a sign-in's discovery document is fetched through. */
export const DISCOVERY_SERVICE_PREFIX = 'discovery:'

const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export interface ProxyDeps {
  getConfig(): Promise<ProxyConfig>
  /** Secrets from files for `env`: the environment's own file over the shared one. */
  readSecrets(env: string): Promise<Record<string, string>>
  env: Record<string, string | undefined>
  /** Secrets typed into the UI this session, per environment (`*` = any); held in memory only. */
  memory?: Record<string, Record<string, string>>
  fetch?: typeof fetch
}

const MOUNT = '/__specbook/proxy'

function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((res, rej) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => res(new Uint8Array(Buffer.concat(parts))))
    req.on('error', rej)
  })
}

/**
 * The dev server's adapter around the shared proxy in `@specbook/core`: it turns a Node request into a
 * `Request`, supplies the project's upstreams and the secret lookup, and writes the `Response` back.
 * What may be forwarded (private hosts, cross-site requests, limits) is decided in core, the same code a
 * hosted Worker and the extension run.
 *
 * Lookup order for `{{secrets.NAME}}`: a value saved in this session for the environment, one for any
 * environment, a process environment variable, the environment's own secrets file, the shared file.
 * (A value the page itself already put in the request is not a placeholder any more, so it wins.)
 */
export async function handleProxy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProxyDeps,
): Promise<boolean> {
  const url = req.url ?? '/'
  if (!url.startsWith(`${MOUNT}/`)) return false

  const config = await deps.getConfig()
  const addressesByEnv = new Map<string, Promise<EnvironmentAddresses>>()
  const addressesFor = (env: string) => {
    let a = addressesByEnv.get(env)
    if (!a) {
      a = config.resolve(env)
      addressesByEnv.set(env, a)
    }
    return a
  }
  const secretsByEnv = new Map<string, Record<string, string>>()
  const method = req.method ?? 'GET'
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers))
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)
  const request = new Request(`http://${req.headers.host ?? 'localhost'}${url}`, {
    method,
    headers,
    body: body?.length ? (body as BodyInit) : undefined,
  })

  const response = await proxy(request, {
    mount: MOUNT,
    policy: {
      upstream: async (env, service) => {
        const a = await addressesFor(env)
        if (service.startsWith(AUTH_SERVICE_PREFIX))
          return a.tokenOrigins[decode(service.slice(AUTH_SERVICE_PREFIX.length))]
        if (service.startsWith(DISCOVERY_SERVICE_PREFIX))
          return a.discoveryOrigins[decode(service.slice(DISCOVERY_SERVICE_PREFIX.length))]
        return a.services[service]
      },
      // a developer's own machine: their local services are the point
      allowPrivateHosts: true,
    },
    lookup: async (name, ctx) => {
      const env = ctx.env ?? ''
      const key = config.secretNames[name]?.env ?? name
      const fromMemory = deps.memory?.[env]?.[name] ?? deps.memory?.['*']?.[name]
      if (fromMemory !== undefined) return fromMemory
      if (deps.env[key] !== undefined) return deps.env[key]
      let local = secretsByEnv.get(env)
      if (!local) {
        local = await deps.readSecrets(env)
        secretsByEnv.set(env, local)
      }
      return local[key]
    },
    fetch: deps.fetch,
  })
  if (!response) return false

  res.statusCode = response.status
  response.headers.forEach((v, k) => {
    res.setHeader(k, v)
  })
  if (response.body) for await (const chunk of response.body) res.write(chunk)
  res.end()
  return true
}
