import {
  createFetchTransport,
  MissingSecretsError,
  requestToWire,
  type Transport,
  WIRE_VERSION,
  type WireCall,
  type WireErrorCode,
  type WireReply,
  wireToResponse,
} from '@specbook/core'

/** Where to get the extension: its Chrome Web Store listing, which Brave installs from and Edge can once it allows other stores. */
export const INSTALL_URL =
  'https://chromewebstore.google.com/detail/specbook/dkkfffjkliimgpadidgabpkmocdefjha'

/**
 * Where this browser gets the extension, or undefined when there is nothing to install: it is built for
 * Chromium on a computer (Chrome, Edge, Brave), so Firefox, Safari and phones are not sent to a download
 * that cannot work for them.
 */
export function extensionInstallUrl(
  userAgent: string | undefined = globalThis.navigator?.userAgent,
): string | undefined {
  const ua = userAgent ?? ''
  const chromium = /(Chrome|Chromium|Edg)\//.test(ua)
  const phone = /Mobile|Android|iPhone|iPad|CriOS|EdgiOS|FxiOS/.test(ua)
  return chromium && !phone ? INSTALL_URL : undefined
}

/** The extension said no, with a reason the page can act on. */
export class WireError extends Error {
  constructor(
    readonly code: WireErrorCode,
    message: string,
    /** the API origin the call was for */
    readonly origin?: string,
  ) {
    super(message)
    this.name = 'WireError'
  }

  /** What the page can offer the person, for a refusal they can fix (the run keeps it with the failed step). */
  get hint(): { code: string; origin?: string } | undefined {
    return this.code === 'not-allowed' || this.code === 'read-only'
      ? { code: this.code, origin: this.origin }
      : undefined
  }
}

/**
 * The page's side of the browser extension. The extension (its own package, not built yet) makes the
 * outbound call from its service worker with the user's grant, using `handleWireFetch` from core, so the
 * policy is the one the dev server and a hosted proxy run. The extension holds no keys: the page supplies them.
 *
 * A bridge is anything that can carry a `WireCall` to it and bring a `WireReply` back: a content script
 * relaying `postMessage`, or a test double.
 */
export interface ExtensionBridge {
  /** Protocol version the extension speaks. */
  version: number
  send(call: WireCall, signal?: AbortSignal): Promise<WireReply>
}

declare global {
  // a content script (or a test) may place its bridge here
  var __SPECBOOK_EXTENSION__: ExtensionBridge | undefined
}

const CHANNEL = 'specbook'

/** Added to a response that came through the extension; the response panel notes it. */
export const VIA_HEADER = 'x-specbook-via'

/** `postMessage` to a content script that answers on the same window. */
function windowBridge(version: number): ExtensionBridge {
  return {
    version,
    send(call, signal) {
      return new Promise<WireReply>((resolve, reject) => {
        const id = (call as { id?: string }).id
        const on = (e: MessageEvent) => {
          const m = e.data as { channel?: string; reply?: WireReply } | undefined
          if (e.source !== window || m?.channel !== `${CHANNEL}:reply` || !m.reply) return
          const r = m.reply as { id?: string; type: string }
          if (id !== undefined && r.id !== id) return
          cleanup()
          resolve(m.reply)
        }
        const abort = () => {
          cleanup()
          window.postMessage({ channel: `${CHANNEL}:call`, call: { v: 1, type: 'abort', id } }, '*')
          reject(new DOMException('aborted', 'AbortError'))
        }
        const cleanup = () => {
          window.removeEventListener('message', on)
          signal?.removeEventListener('abort', abort)
        }
        window.addEventListener('message', on)
        signal?.addEventListener('abort', abort)
        window.postMessage({ channel: `${CHANNEL}:call`, call }, '*')
      })
    },
  }
}

/** The bridge when an extension is installed and enabled for this page, within a short wait. */
export async function detectExtension(waitMs = 250): Promise<ExtensionBridge | undefined> {
  const injected = globalThis.__SPECBOOK_EXTENSION__
  if (injected) return injected
  if (typeof window === 'undefined') return undefined
  const bridge = windowBridge(WIRE_VERSION)
  // an abort takes the listener off the window, so a page with no extension does not collect one per look
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), waitMs)
  try {
    const pong = await bridge.send({ v: 1, type: 'ping' }, ctl.signal)
    return pong.type === 'pong' ? { ...bridge, version: pong.version } : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether the extension speaks a protocol this page can use. An extension from before a protocol change
 * answers `ping` but cannot be relied on for what came after, so the page tells the person to update it
 * rather than send it calls it may mishandle. A newer extension is fine: the protocol only adds fields.
 */
export const extensionLevel = (bridge: ExtensionBridge): 'ready' | 'outdated' =>
  bridge.version >= WIRE_VERSION ? 'ready' : 'outdated'

/** Which of these API origins the person has allowed for this page. Asks nobody anything. */
export async function wireStatus(
  bridge: ExtensionBridge,
  apiOrigins: string[],
): Promise<{ granted: string[]; missing: string[] }> {
  const r = await bridge.send({ v: 1, type: 'status', apiOrigins })
  if (r.type !== 'status') return { granted: [], missing: apiOrigins }
  return { granted: r.granted, missing: r.missing }
}

/**
 * Ask the extension to put the missing origins in front of the person, or with `writes` to ask whether this
 * page may change data at origins it may already read. It answers at once, not on their reply.
 */
export async function wireGrant(
  bridge: ExtensionBridge,
  apiOrigins: string[],
  opts?: { writes?: boolean },
): Promise<{ granted: string[]; missing: string[] }> {
  const r = await bridge.send({
    v: 1,
    type: 'grant',
    apiOrigins,
    ...(opts?.writes ? { writes: true } : {}),
  })
  if (r.type !== 'status') return { granted: [], missing: apiOrigins }
  return { granted: r.granted, missing: r.missing }
}

let counter = 0

/**
 * A `Transport` that sends each request to the extension. Built on the ordinary fetch transport with a
 * `fetch` that carries the request over the bridge, so bodies, query strings and response parsing are
 * the same as for a direct call.
 */
export function extensionTransport(
  bridge: ExtensionBridge,
  baseOf: (service: string) => string,
): Transport {
  const carry: typeof fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init)
    const id = `c${Date.now().toString(36)}${counter++}`
    const reply = await bridge.send(
      { v: 1, type: 'fetch', id, req: await requestToWire(req) },
      init?.signal ?? undefined,
    )
    if (reply.type === 'error') {
      if (reply.code === 'missing-secrets')
        throw new MissingSecretsError(
          reply.message
            .replace(/^Missing secrets:\s*/, '')
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean),
        )
      const origin = new URL(req.url).origin
      throw new WireError(reply.code, reply.message, origin)
    }
    if (reply.type !== 'response') throw new Error('unexpected reply from the extension')
    const res = wireToResponse(reply.res)
    // so the response panel can say it came through the extension
    res.headers.set(VIA_HEADER, 'extension')
    return res
  }
  return createFetchTransport({ baseUrl: baseOf, fetch: carry })
}
