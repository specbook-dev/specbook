import { describe, expect, it } from 'vitest'
import {
  defineOperation,
  type PreparedRequest,
  type RawResponse,
  runRequest,
  runSequence,
  sequence,
  type Transport,
  withMock,
} from '../src'

/**
 * A run is shown to a person, and what they see is what the run returns. Whatever the API answers, and whatever the
 * project's own code does with the answer, a run must come back with a result in full shape: every step with its checks and
 * what it captured, and an error that says what happened. A result that is missing a part is how a panel ends up stuck.
 */

const Get = defineOperation<{
  params: { path: { id: string } }
  body: never
  responses: { 200: { id: number; name: string }; 404: { message: string } }
}>({ service: 'pets', id: 'Get', method: 'GET', path: '/pet/{id}' })

const answer =
  (r: Partial<RawResponse>): Transport =>
  async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    text: '',
    body: undefined,
    ...r,
  })

const ANSWERS: [string, Transport][] = [
  ['an empty body', answer({ status: 200, text: '', body: undefined })],
  ['an error with no body', answer({ status: 500, text: '', body: undefined })],
  [
    'html where json was promised',
    answer({
      status: 502,
      text: '<html>Bad gateway</html>',
      body: undefined,
      headers: { 'content-type': 'text/html' },
    }),
  ],
  ['json that is not json', answer({ status: 200, text: '{"id": ', body: undefined })],
  ['null', answer({ status: 200, text: 'null', body: null })],
  ['a list where an object was promised', answer({ status: 200, text: '[1,2]', body: [1, 2] })],
  ['a number', answer({ status: 200, text: '7', body: 7 })],
  ['an object with other fields', answer({ status: 200, text: '{"x":1}', body: { x: 1 } })],
  ['a status the spec does not list', answer({ status: 418, text: '{}', body: {} })],
  [
    'a very long text',
    answer({
      status: 200,
      text: 'x'.repeat(2_000_000),
      body: undefined,
      headers: { 'content-type': 'text/plain' },
    }),
  ],
  ['no headers at all', answer({ status: 200, headers: undefined as never, text: '{}', body: {} })],
  [
    'a transport that throws',
    async () => {
      throw new Error('connection reset')
    },
  ],
  [
    'a transport that throws something that is no error',
    async () => {
      throw 'plain text'
    },
  ],
]

const request = (extra: Record<string, unknown> = {}) =>
  Get.request({
    path: { id: '1' },
    capture: { id: (res: any) => res.data.id, name: (res: any) => res.data.name },
    assert: (res: any, { assert }: any) => {
      assert.is(res.status, 200, 'found')
      assert.is(res.data.id, 1, 'the pet asked for')
    },
    ...extra,
  } as never)

/** The shape every consumer of a result relies on. */
function inFullShape(result: Awaited<ReturnType<typeof runRequest>>) {
  expect(['pass', 'fail', 'error']).toContain(result.status)
  expect(result.steps.length).toBeGreaterThan(0)
  for (const s of result.steps) {
    expect(Array.isArray(s.assertions), `${s.name}: assertions`).toBe(true)
    expect(typeof s.captured, `${s.name}: captured`).toBe('object')
    expect(s.captured).not.toBeNull()
    expect(typeof s.name).toBe('string')
    // a step skipped after an earlier one failed has nothing to report; one that failed or errored says why
    if (s.status === 'fail' || s.status === 'error')
      expect(typeof s.error === 'string' || s.assertions.some((a) => !a.pass), s.name).toBe(true)
    for (const a of s.assertions) expect(typeof a.label).toBe('string')
  }
}

describe('a run, whatever the API answers', () => {
  it.each(ANSWERS)('comes back whole for %s', async (_name, transport) => {
    const result = await runRequest(request(), { env: 'live', transport, vars: {} })
    inFullShape(result)
  })

  it.each(ANSWERS)(
    'comes back whole in a flow, with what follows skipped, for %s',
    async (_name, transport) => {
      const flow = sequence({ id: 'f', title: 'F' }).step('Get', request()).step('Again', request())
      const result = await runSequence(flow, { env: 'live', transport, vars: {} })
      inFullShape(result)
      // a step that did not pass stops the flow: nothing after it ran
      const failed = result.steps.findIndex((s) => s.status !== 'pass')
      if (failed >= 0)
        for (const s of result.steps.slice(failed + 1)) expect(s.status).toBe('skipped')
    },
  )
})

describe("a run, whatever the project's own code does", () => {
  const ok = answer({ status: 200, text: '{"id":1,"name":"Rex"}', body: { id: 1, name: 'Rex' } })
  const cases: [string, ReturnType<typeof request>][] = [
    [
      'a check that throws',
      Get.request({
        path: { id: '1' },
        assert: () => {
          throw new Error('boom')
        },
      } as never),
    ],
    [
      'a check that throws something that is no error',
      Get.request({
        path: { id: '1' },
        assert: () => {
          throw 'plain'
        },
      } as never),
    ],
    [
      'a capture that throws',
      Get.request({
        path: { id: '1' },
        capture: {
          x: () => {
            throw new Error('nope')
          },
        },
      } as never),
    ],
    [
      'a capture of undefined',
      Get.request({ path: { id: '1' }, capture: { x: () => undefined } } as never),
    ],
    [
      'a capture that cannot be written as json',
      Get.request({
        path: { id: '1' },
        capture: {
          x: () => {
            const a: any = {}
            a.self = a
            return a
          },
        },
      } as never),
    ],
    [
      'a capture of a function',
      Get.request({ path: { id: '1' }, capture: { x: () => () => 1 } } as never),
    ],
    [
      'a capture of a big int',
      Get.request({ path: { id: '1' }, capture: { x: () => BigInt(5) } } as never),
    ],
    [
      'an async check that rejects',
      Get.request({
        path: { id: '1' },
        assert: async () => {
          throw new Error('later')
        },
      } as never),
    ],
    [
      'a mock hook that throws',
      withMock(Get.request({ path: { id: '1' } }), () => {
        throw new Error('hook')
      }),
    ],
  ]
  it.each(cases)('comes back whole for %s', async (_name, def) => {
    const env = _name.includes('hook') ? 'mock' : 'live'
    const transport: Transport =
      env === 'mock'
        ? async () => {
            throw new Error('unused')
          }
        : ok
    const result = await runRequest(def as never, {
      env,
      transport,
      vars: {},
      ...(env === 'mock' ? {} : {}),
    })
    inFullShape(result)
  })
})
