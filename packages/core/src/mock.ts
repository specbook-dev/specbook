// In-process mock transport: answers from the generated examples, filled in from the request that was sent, and lets a
// request's `withMock` hook change the answer.
import { reflectRequest } from './mock-reflect'
import { pickMockVariant } from './mock-variants'
import type { PreparedRequest, RawResponse, Transport } from './runner/transport'
import { deepMerge, render } from './template'

export interface MockExampleLoader {
  /** Statuses that have an example for this operation, in spec order. */
  statuses(service: string, opId: string): number[] | Promise<number[]>
  example(service: string, opId: string, status: number): unknown | Promise<unknown>
}

export interface MockTransportOptions {
  loader: MockExampleLoader
  /** Waits a mock's `delayMs`. The default can be ended early by the run's signal: a person pressing Stop. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

const is2xx = (s: number) => s >= 200 && s < 300

/** The loader may hand out one object to every caller, and a hook edits what it is given. */
const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

/** A header that carries a credential: an API key or a token (`X-Api-Key`, `X-Shopify-Access-Token`), a secret or a client id (Plaid's `PLAID-SECRET`, `PLAID-CLIENT-ID`). */
const CREDENTIAL_HEADER = /api[-_]?key|token|secret|client[-_]?id/i

export function createMockTransport(opts: MockTransportOptions): Transport {
  const sleep =
    opts.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      new Promise<void>((done, stop) => {
        if (signal?.aborted) return stop(new Error('Stopped before the API answered.'))
        const timer = setTimeout(done, ms)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            stop(new Error('Stopped before the API answered.'))
          },
          { once: true },
        )
      }))
  return async (req: PreparedRequest, signal?: AbortSignal): Promise<RawResponse> => {
    const hints = req.mock
    const all = await opts.loader.statuses(req.service, req.opId)
    const status = req.mockStatus ?? all.find(is2xx) ?? all[0] ?? 200
    // a status's file may hold several variants: the one asked for, else the first
    const example = async (s: number, variant?: string) =>
      pickMockVariant(await opts.loader.example(req.service, req.opId, s), variant)

    // Secured operations answer 401 when no credential header was applied.
    if (
      hints?.secured &&
      !req.headers.authorization &&
      !Object.keys(req.headers).some((h) => CREDENTIAL_HEADER.test(h)) &&
      req.mockStatus === undefined &&
      all.includes(401)
    ) {
      return json(401, await example(401))
    }

    const scope = {
      ...(hints?.vars ?? {}),
      ...(hints?.pathParams ?? {}),
      ...(hints?.rawQuery ?? {}),
    }
    // The generated example answers the request that was sent, so a created thing has the fields you posted.
    // A declared status without a response schema (e.g. Petstore's 404) has no example: empty body.
    const answer = async (s: number, variant?: string) => {
      let template: unknown = copy(await example(s, variant))
      if (is2xx(s))
        template = reflectRequest(template, {
          body: req.body,
          path: hints?.pathParams,
          query: hints?.rawQuery,
        })
      return template === undefined ? undefined : render(template, scope)
    }

    const res: {
      status: number
      data: unknown
      headers: Record<string, string>
      delayMs: number
      respond(status: number, data?: unknown, variant?: string): void
    } = {
      status,
      // a variant is asked for the status that was forced, nothing else
      data: await answer(status, req.mockStatus === undefined ? undefined : req.mockVariant),
      headers: {},
      delayMs: 0,
      respond: (s, data, variant) => {
        pending = { status: s, data, variant }
      },
    }
    let pending: { status: number; data?: unknown; variant?: string } | undefined

    if (hints?.hook) {
      await hints.hook(
        {
          vars: (hints.vars ?? {}) as never,
          body: req.body,
          query: hints.rawQuery,
          path: hints.pathParams,
          headers: req.headers,
        },
        res as never,
      )
    }
    if (pending) {
      const base = await answer(pending.status, pending.variant)
      res.status = pending.status
      res.data = pending.data === undefined ? base : deepMerge(base, pending.data)
    }

    if (res.delayMs) await sleep(res.delayMs, signal)
    return {
      ...json(res.status, res.data),
      headers: { 'content-type': 'application/json', ...res.headers },
    }
  }
}

function json(status: number, body: unknown): RawResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    text: body === undefined ? '' : JSON.stringify(body),
    body,
  }
}
