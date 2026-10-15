// In-process mock transport: serves request-level mock overrides, falling back to generated examples.
import { reflectRequest } from './mock-reflect'
import type { PreparedRequest, RawResponse, Transport } from './runner/transport'
import { deepMerge, render } from './template'
import type { MockResponse } from './types'

export interface MockExampleLoader {
  /** Statuses that have an example for this operation, in spec order. */
  statuses(service: string, opId: string): number[] | Promise<number[]>
  example(service: string, opId: string, status: number): unknown | Promise<unknown>
}

export interface MockTransportOptions {
  loader: MockExampleLoader
  sleep?: (ms: number) => Promise<void>
}

const isMockResponse = (v: unknown): v is MockResponse<unknown> =>
  v !== null &&
  typeof v === 'object' &&
  ('data' in (v as object) ||
    'init' in (v as object) ||
    'headers' in (v as object) ||
    'delayMs' in (v as object))

function evalInit(init: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    Object.entries(init ?? {}).map(([k, v]) => [
      k,
      typeof v === 'function' ? (v as () => unknown)() : v,
    ]),
  )
}

export function createMockTransport(opts: MockTransportOptions): Transport {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  return async (req: PreparedRequest): Promise<RawResponse> => {
    const hints = req.mock
    const cfg = hints?.config
    const known = await opts.loader.statuses(req.service, req.opId)
    const overridden = Object.keys(cfg?.responses ?? {}).map(Number)
    const all = [...new Set([...known, ...overridden])]

    const fromWhen = cfg?.when?.({
      vars: (hints?.vars ?? {}) as never,
      body: req.body,
      query: hints?.rawQuery,
      path: hints?.pathParams,
    })
    const status =
      req.mockStatus ??
      fromWhen ??
      cfg?.status ??
      all.find((s) => s >= 200 && s < 300) ??
      all[0] ??
      200

    // Secured operations answer 401 when no credential header was applied.
    if (
      hints?.secured &&
      !req.headers.authorization &&
      !Object.keys(req.headers).some((h) => /api[-_]?key|token/i.test(h)) &&
      req.mockStatus === undefined &&
      all.includes(401)
    ) {
      const body = await opts.loader.example(req.service, req.opId, 401)
      return json(401, body)
    }

    const override = (cfg?.responses as Record<number, unknown> | undefined)?.[status]
    let delay = 0
    let headers: Record<string, string> = {}
    let scope = { ...(hints?.vars ?? {}), ...(hints?.pathParams ?? {}), ...(hints?.rawQuery ?? {}) }
    let template: unknown = await opts.loader.example(req.service, req.opId, status)
    // The generated example answers the request that was sent, so a created thing has the fields you posted.
    if (status >= 200 && status < 300 && cfg?.reflect !== false)
      template = reflectRequest(template, {
        body: req.body,
        path: hints?.pathParams,
        query: hints?.rawQuery,
      })
    // A declared status without a response schema (e.g. Petstore's 404) has no example: empty body.
    if (override !== undefined) {
      // Overrides are layered over the generated example (objects merge, arrays/scalars replace).
      let data: unknown
      if (isMockResponse(override)) {
        data = await resolveSource(override.data)
        scope = { ...scope, ...evalInit(override.init) }
        headers = override.headers ? render(override.headers, scope) : {}
        delay = override.delayMs ?? 0
      } else {
        data = await resolveSource(override)
      }
      if (data !== undefined) template = deepMerge(template, data)
    }
    if (delay) await sleep(delay)
    const body = template === undefined ? undefined : render(template, scope)
    return { ...json(status, body), headers: { 'content-type': 'application/json', ...headers } }
  }
}

async function resolveSource(src: unknown): Promise<unknown> {
  if (typeof src === 'function')
    return (await (src as () => Promise<{ default: unknown }>)()).default
  return src
}

function json(status: number, body: unknown): RawResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    text: body === undefined ? '' : JSON.stringify(body),
    body,
  }
}
