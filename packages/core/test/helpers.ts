import type { PreparedRequest, RawResponse, Transport } from '../src'

/** Fake transport driven by a handler; records every wire request. */
export function fakeTransport(
  handler: (req: PreparedRequest, n: number) => Partial<RawResponse> & { body?: unknown },
) {
  const calls: PreparedRequest[] = []
  const transport: Transport = async (req) => {
    calls.push(req)
    const r = handler(req, calls.length)
    return {
      status: r.status ?? 200,
      headers: r.headers ?? {},
      text: r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body)),
      body: r.body,
    }
  }
  return { transport, calls }
}
