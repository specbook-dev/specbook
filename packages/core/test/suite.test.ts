import { describe, expect, it } from 'vitest'
import { createColors, defineOperation, headerLine, retryLine, runSuite } from '../src/internal'
import { fakeTransport } from './helpers'

const Get = defineOperation<{
  params: {}
  body: never
  responses: { 200: { ok: boolean }; 500: { message: string } }
}>({ service: 'svc', id: 'Get', method: 'GET', path: '/x' })

const check = Get.request({
  assert: (res, { assert }) => assert.is(res.status, 200, 'ok'),
})
const target = (title: string) => ({ title, tags: [], run: check })

const base = (transport: ReturnType<typeof fakeTransport>['transport']) => ({
  env: 'test',
  vars: { svcUrl: 'http://x' },
  transport,
})

describe('runSuite', () => {
  it('retries a failure and marks a pass after one as flaky', async () => {
    const { transport } = fakeTransport((_req, n) =>
      n === 1 ? { status: 500, body: { message: 'x' } } : { body: { ok: true } },
    )
    const retried: string[] = []
    const r = await runSuite([target('a')], {
      run: base(transport),
      retries: 1,
      onRetry: (t, attempt, allowed) => retried.push(`${t.title} ${attempt}/${allowed}`),
    })
    expect(retried).toEqual(['a 2/2'])
    expect(r.results[0]).toMatchObject({ status: 'pass', attempts: 2, flaky: true })
    expect(r.failures).toBe(0)
  })

  it('stops at --bail and says how many did not run', async () => {
    const { transport } = fakeTransport(() => ({ status: 500, body: { message: 'x' } }))
    const r = await runSuite([target('a'), target('b'), target('c')], {
      run: base(transport),
      bail: 1,
    })
    expect(r.results).toHaveLength(1)
    expect(r.notRun).toBe(2)
    expect(r.stopped).toMatch(/after 1 failed flow \(--bail\)/)
  })

  it('runs everything when nothing fails', async () => {
    const { transport } = fakeTransport(() => ({ body: { ok: true } }))
    const r = await runSuite([target('a'), target('b')], { run: base(transport) })
    expect(r.results.map((x) => x.status)).toEqual(['pass', 'pass'])
    expect(r.stopped).toBe('')
  })
})

describe('the lines a run prints', () => {
  const plain = createColors(false)
  it('opens with the tool, version, environment and how many of the tests', () => {
    expect(
      headerLine(
        { version: '0.2.0', env: 'demo', picked: 2, total: 5, where: ['main@abc'] },
        plain,
      ),
    ).toBe('specbook test 0.2.0  env demo  ·  2/5 tests  ·  main@abc\n\n')
    expect(headerLine({ version: '0.2.0', env: 'demo', picked: 5, total: 5 }, plain)).toContain(
      '5 tests',
    )
  })
  it('says when it retries', () => {
    expect(retryLine(plain, 'Find pets', 2, 3)).toBe('  ↻ retrying Find pets (attempt 2 of 3)\n')
  })
})
