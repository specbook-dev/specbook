import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMEOUT_MS,
  defineOperation,
  runRequest,
  runSequence,
  sequence,
} from '../src/internal'
import { fakeTransport } from './helpers'

const Get = defineOperation<{
  params: {}
  body: never
  responses: { 200: { ok: boolean } }
}>({ service: 's', id: 'Get', method: 'GET', path: '/x' })

/** The time each request was given to be answered in, as the transport sees it. */
async function given(def = Get.request(), options: { timeoutMs?: number } = {}) {
  const { transport, calls } = fakeTransport(() => ({ body: { ok: true } }))
  await runRequest(def, { env: 'live', transport, vars: {}, ...options })
  return calls.map((c) => c.timeoutMs)
}

describe('how long a request waits for its answer', () => {
  it('is 30 seconds when nothing says otherwise', async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000)
    expect(await given()).toEqual([30_000])
  })

  it("is the run's timeoutMs when it has one, for a request and for each step of a flow", async () => {
    expect(await given(Get.request(), { timeoutMs: 8_000 })).toEqual([8_000])
    const { transport, calls } = fakeTransport(() => ({ body: { ok: true } }))
    await runSequence(
      sequence({ id: 'f', title: 'F' }).step('a', Get.request()).step('b', Get.request()),
      { env: 'live', transport, vars: {}, timeoutMs: 8_000 },
    )
    expect(calls.map((c) => c.timeoutMs)).toEqual([8_000, 8_000])
  })

  it("is the request's own timeoutMs when it has one, over the run's", async () => {
    expect(await given(Get.request({ timeoutMs: 1_500 }), { timeoutMs: 8_000 })).toEqual([1_500])
  })

  it('waits as long as it takes when it is 0', async () => {
    expect(await given(Get.request(), { timeoutMs: 0 })).toEqual([0])
  })
})
