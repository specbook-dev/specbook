import { parseWireCall, WIRE_VERSION } from '@specbook/core/internal'

/** The page's two channel names: the page side (`packages/ui/src/extension.ts`) uses the same. */
export const CALL_CHANNEL = 'specbook:call'
export const REPLY_CHANNEL = 'specbook:reply'

export interface Link {
  post(message: unknown): void
  onMessage(cb: (message: unknown) => void): void
  onClose(cb: () => void): void
  close(): void
}

export interface RelayEnv {
  /** a reply for the page */
  toPage(message: { channel: string; reply: unknown }): void
  /** a new line to the worker */
  connect(): Link
}

/**
 * The content script's whole job, with the browser's APIs passed in. A page's message is accepted only when
 * it is well formed (`parseWireCall` keeps the fields it knows and drops the rest); `ping` is answered here,
 * without waking the worker, so detection is fast; every other call gets its own line to the worker, which
 * is what keeps the worker alive for the length of the request and turns a closed line into an abort.
 */
export function createRelay(env: RelayEnv) {
  const live = new Map<string, Link>()
  const reply = (r: unknown) => env.toPage({ channel: REPLY_CHANNEL, reply: r })

  return function fromPage(data: unknown): void {
    const m = data as { channel?: unknown; call?: unknown } | null
    if (!m || m.channel !== CALL_CHANNEL) return
    const call = parseWireCall(m.call)
    if (!call) return

    if (call.type === 'ping') {
      reply({ v: 1, type: 'pong', version: WIRE_VERSION })
      return
    }
    if (call.type === 'abort') {
      live.get(call.id)?.close()
      live.delete(call.id)
      return
    }

    const id = call.type === 'fetch' ? call.id : undefined
    const link = env.connect()
    if (id) live.set(id, link)
    let answered = false
    link.onMessage((msg) => {
      const r = (msg as { reply?: unknown } | null)?.reply
      if (r === undefined) return
      answered = true
      reply(r)
      if (id) live.delete(id)
      link.close()
    })
    link.onClose(() => {
      if (id) live.delete(id)
      // the worker went away without answering: the page must not wait for ever
      if (!answered && id)
        reply({ v: 1, type: 'error', id, code: 'network', message: 'the extension did not answer' })
    })
    link.post({ call })
  }
}
