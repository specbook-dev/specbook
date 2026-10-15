import {
  createFetchTransport,
  requestToWire,
  type Transport,
  WIRE_VERSION,
  type WireCall,
  type WireReply,
  wireToResponse,
} from '@specbook/core'

/**
 * The page's side of the browser extension. The extension (its own package, not built yet) makes the
 * outbound call from its service worker with the user's grant, using `handleWireFetch` from core, so the
 * policy and secret substitution are the ones the dev server and a hosted proxy run.
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
  const timeout = new Promise<undefined>((r) => setTimeout(() => r(undefined), waitMs))
  const pong = await Promise.race([
    bridge.send({ v: 1, type: 'ping' }).catch(() => undefined),
    timeout,
  ])
  return pong?.type === 'pong' ? { ...bridge, version: pong.version } : undefined
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
    if (reply.type === 'error') throw new Error(reply.message)
    if (reply.type !== 'response') throw new Error('unexpected reply from the extension')
    return wireToResponse(reply.res)
  }
  return createFetchTransport({ baseUrl: baseOf, fetch: carry })
}
