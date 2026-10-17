import type { PreparedRequest, RawResponse, Transport } from '@specbook/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEOUT_MS, withDefaultTimeout } from '../src/routing'

const request = (extra: Partial<PreparedRequest> = {}): PreparedRequest => ({
  service: 's',
  opId: 'o',
  method: 'GET',
  url: '/x',
  query: {},
  headers: {},
  encoding: 'json',
  ...extra,
})

describe('a request in the browser always has a time to be answered in', () => {
  const seen: (number | undefined)[] = []
  const inner: Transport = async (req): Promise<RawResponse> => {
    seen.push(req.timeoutMs)
    return { status: 200, headers: {}, text: '', body: undefined }
  }
  it("is the command line's 30 seconds unless the request says otherwise", async () => {
    seen.length = 0
    const t = withDefaultTimeout(inner)
    await t(request())
    await t(request({ timeoutMs: 5_000 }))
    expect(seen).toEqual([DEFAULT_TIMEOUT_MS, 5_000])
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000)
  })
})
