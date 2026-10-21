/**
 * What an extension's worker does with the messages a page sends, with the browser's own APIs left out: the
 * grants and the audit trail are injected (`WireHost`), so the whole decision path is a plain
 * function that is tested without a browser. The worker only has to implement `WireHost` on top of
 * `chrome.permissions` and `chrome.storage`, and call `handle` with the sender's origin *as the browser
 * reports it*: nothing the page says about itself is used.
 */
import type { ProxyEvent } from './forward'
import {
  handleWireFetch,
  WIRE_VERSION,
  type WireCall,
  type WireErrorCode,
  type WireFetchDeps,
  type WireReply,
} from './wire'

export interface WireAuditEvent {
  /** milliseconds since the epoch */
  at: number
  /** the page's origin, from the browser */
  site: string
  /** the API's origin */
  origin: string
  method: string
  /** no query string: it may carry a secret the page filled in */
  path: string
  outcome: 'ok' | 'error' | 'refused'
  status?: number
  code?: WireErrorCode
  ms: number
}

export interface WireHost {
  /** Has this site been allowed to reach this API origin? */
  isGranted(site: string, apiOrigin: string): boolean | Promise<boolean>
  /** May this pair send POST, PUT, PATCH or DELETE? Default: no, a pair is read-only until the person says. */
  allowsWrites?(site: string, apiOrigin: string): boolean | Promise<boolean>
  /** May this pair reach a private or loopback address? Default: no. */
  allowsPrivate?(site: string, apiOrigin: string): boolean | Promise<boolean>
  /** Ask the person about these origins (the extension opens its own window). Returns once asked. */
  requestGrant?(
    site: string,
    apiOrigins: string[],
    opts?: { writes?: boolean },
  ): void | Promise<void>
  /** Is the page relay enabled for this site? Default: yes, a message got here. */
  pageEnabled?(site: string): boolean | Promise<boolean>
  record?(e: WireAuditEvent): void
  fetch?: typeof fetch
  now?(): number
  /** Requests per minute for one (site, API origin) pair. Default 30. */
  perMinute?: number
  /** Limits (body size, timeout, methods) applied on top of the defaults. */
  policy?: WireFetchDeps['policy']
}

/** The methods that do not change anything on the API. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const WINDOW_MS = 60_000

export function createWireHandler(host: WireHost) {
  const now = () => host.now?.() ?? Date.now()
  const perMinute = host.perMinute ?? 30
  const inflight = new Map<string, AbortController>()
  const hits = new Map<string, number[]>()

  const error = (id: string, code: WireErrorCode, message: string): WireReply => ({
    v: 1,
    type: 'error',
    id,
    code,
    message,
  })

  async function status(site: string, apiOrigins: string[]) {
    const granted: string[] = []
    const missing: string[] = []
    for (const o of apiOrigins) ((await host.isGranted(site, o)) ? granted : missing).push(o)
    return {
      v: 1 as const,
      type: 'status' as const,
      granted,
      missing,
      pageEnabled: (await host.pageEnabled?.(site)) ?? true,
    }
  }

  async function fetchCall(call: Extract<WireCall, { type: 'fetch' }>, site: string) {
    const started = now()
    let origin: string
    let path: string
    try {
      const u = new URL(call.req.url)
      origin = u.origin
      path = u.pathname
    } catch {
      return error(call.id, 'blocked', 'the request has no valid URL')
    }
    const method = call.req.method.toUpperCase()
    const audit = (
      outcome: WireAuditEvent['outcome'],
      extra: Pick<WireAuditEvent, 'status' | 'code'> = {},
    ) =>
      host.record?.({
        at: started,
        site,
        origin,
        method,
        path,
        outcome,
        ms: now() - started,
        ...extra,
      })

    if (!(await host.isGranted(site, origin))) {
      audit('refused', { code: 'not-allowed' })
      return error(call.id, 'not-allowed', `${origin} has not been allowed for ${site}`)
    }
    if (!READ_METHODS.has(method) && !(await host.allowsWrites?.(site, origin))) {
      audit('refused', { code: 'read-only' })
      return error(
        call.id,
        'read-only',
        `${site} may read ${origin} but has not been allowed to modify data there. Turn on Modify data in the Specbook extension to send ${method}.`,
      )
    }
    // a page that loops should hit a wall, and the wall is per pair so another API is not slowed
    const key = `${site}\n${origin}`
    const recent = (hits.get(key) ?? []).filter((t) => started - t < WINDOW_MS)
    if (recent.length >= perMinute) {
      hits.set(key, recent)
      audit('refused', { code: 'rate-limited' })
      return error(
        call.id,
        'rate-limited',
        `${site} has sent ${perMinute} requests to ${origin} in the last minute. Wait a moment.`,
      )
    }
    recent.push(started)
    hits.set(key, recent)

    const ctl = new AbortController()
    const id = `${site}\n${call.id}`
    inflight.set(id, ctl)
    let status: number | undefined
    try {
      const reply = await handleWireFetch(
        call,
        {
          allow: () => true, // checked above, for the pair
          fetch: host.fetch,
          onEvent: (e: ProxyEvent) => {
            status = e.status
          },
          policy: {
            ...host.policy,
            allowPrivateHosts: (await host.allowsPrivate?.(site, origin)) ?? false,
          },
        },
        ctl.signal,
      )
      if (reply.type === 'error') audit('error', { code: reply.code, status })
      else audit('ok', { status: reply.type === 'response' ? reply.res.status : status })
      return reply
    } finally {
      inflight.delete(id)
    }
  }

  return {
    /**
     * One message from a page. `site` is the page's origin as the browser reports it. Resolves to the reply,
     * or `undefined` for a message that has none (an abort).
     */
    async handle(call: WireCall, who: { site: string }): Promise<WireReply | undefined> {
      const { site } = who
      switch (call.type) {
        case 'ping':
          return { v: 1, type: 'pong', version: WIRE_VERSION }
        case 'status':
          return status(site, call.apiOrigins)
        case 'grant': {
          const s = await status(site, call.apiOrigins)
          if (call.writes) {
            // only an origin that may be read can be asked about changes; the rest need a grant first
            const readOnly: string[] = []
            for (const o of s.granted) if (!(await host.allowsWrites?.(site, o))) readOnly.push(o)
            if (readOnly.length) await host.requestGrant?.(site, readOnly, { writes: true })
          } else if (s.missing.length) await host.requestGrant?.(site, s.missing)
          return s
        }
        case 'abort':
          inflight.get(`${site}\n${call.id}`)?.abort()
          return undefined
        case 'fetch':
          return fetchCall(call, site)
      }
    },
  }
}
