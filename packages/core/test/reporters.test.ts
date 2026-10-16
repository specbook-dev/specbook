import { describe, expect, it } from 'vitest'
import {
  buildReport,
  codeFrame,
  colorEnabled,
  createColors,
  createListReporter,
  defineOperation,
  detectCi,
  diffAssertion,
  formatFailures,
  formatGithub,
  formatList,
  formatSummary,
  githubSummary,
  isSensitiveKey,
  type RunEvent,
  type RunResult,
  redactResults,
  runRequest,
  runSequence,
  sequence,
  statusText,
  testExitCode,
  toJUnit,
  traceLines,
} from '../src'
import { fakeTransport } from './helpers'

const GetPet = defineOperation<{
  params: { path: { id: string } }
  body: never
  responses: { 200: { id: string; name: string } }
}>({ service: 'pets', id: 'GetPet', method: 'GET', path: '/pet/{id}' })

const origins = { pets: 'https://api.example.test' }

/** A run with a failed equality, an implicit-status failure and a passing step. */
async function failingFlow() {
  const events: RunEvent[] = []
  const { transport } = fakeTransport((req) =>
    req.url === '/pet/1'
      ? {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'sid=abc',
            'x-request-id': 'r-1',
          },
          body: { id: '1', name: 'Rex', access_token: 'tok_should_not_show' },
        }
      : { status: 404, body: { message: 'no such pet' } },
  )
  const wrong = GetPet.request({
    name: 'Get pet 1',
    path: { id: '1' },
    headers: { authorization: 'Bearer {{secrets.PET_KEY}}' },
    assert: (res, { assert }) =>
      assert.equal(res.data, { id: '1', name: 'Rover' }, 'name is Rover'),
  })
  const missing = GetPet.request({ name: 'Get pet 9', path: { id: '9' } })
  const ok = GetPet.request({
    name: 'Get pet 1 again',
    path: { id: '1' },
    assert: (r, { assert }) => assert.is(r.status, 200, 'ok'),
  })
  const flow = sequence({ id: 'pets', title: 'Pets', tags: ['monitor'], continueOnFailure: true })
    .step('Get pet 1', wrong)
    .step('Get pet 9', missing)
    .step('again', ok)
  const r = await runSequence(flow, {
    env: 'staging',
    transport,
    implicitStatusCheck: true,
    secrets: { PET_KEY: 'sk_live_123456' },
    onEvent: (e) => events.push(e),
  })
  return { r: { ...r, file: 'sequences/pets.seq.ts' } as RunResult, events }
}

describe('diffAssertion', () => {
  const a = (extra: object) => ({ label: 'l', operator: 'equal', pass: false, ...extra })

  it('compares values line by line', () => {
    const lines = diffAssertion(
      a({ expected: { id: 1, name: 'Rex' }, actual: { id: 1, name: 'Rover' } }),
    )
    expect(lines.filter((l) => l.kind === 'expected').map((l) => l.text)).toEqual([
      '  "name": "Rex"',
    ])
    expect(lines.filter((l) => l.kind === 'received').map((l) => l.text)).toEqual([
      '  "name": "Rover"',
    ])
    expect(lines.some((l) => l.kind === 'same' && l.text === '{')).toBe(true)
  })

  it('shows primitives as one pair of lines', () => {
    expect(diffAssertion(a({ operator: 'is', expected: 3, actual: 4 }))).toEqual([
      { kind: 'expected', text: '3' },
      { kind: 'received', text: '4' },
    ])
    expect(diffAssertion(a({ operator: 'is', expected: 'a', actual: 'b' }))[0]).toEqual({
      kind: 'expected',
      text: '"a"',
    })
  })

  it('reads a status check in words', () => {
    expect(diffAssertion(a({ operator: 'status', expected: '2xx', actual: 404 }))).toEqual([
      { kind: 'expected', text: 'status 2xx' },
      { kind: 'received', text: 'status 404 Not Found' },
    ])
    expect(statusText(503)).toBe('Service Unavailable')
  })

  it('keeps only the lines around a change in a long value', () => {
    const big = Array.from({ length: 40 }, (_, i) => i)
    const other = [...big]
    other[20] = 99
    const lines = diffAssertion(a({ expected: big, actual: other }))
    expect(lines.length).toBeLessThan(20)
    expect(lines.some((l) => l.kind === 'skip')).toBe(true)
  })

  it('falls back to a recorded diff when there are no values', () => {
    expect(diffAssertion(a({ diff: 'x\ny' })).map((l) => l.text)).toEqual(['x', 'y'])
    expect(diffAssertion(a({}))).toEqual([])
  })
})

describe('redaction', () => {
  it('recognizes sensitive keys by their last word, not by a fragment', () => {
    for (const k of [
      'access_token',
      'accessToken',
      'client-secret',
      'password',
      'apiKey',
      'api_key',
      'Authorization',
    ])
      expect(isSensitiveKey(k)).toBe(true)
    for (const k of ['tokenCount', 'name', 'key', 'secretary', 'status'])
      expect(isSensitiveKey(k)).toBe(false)
  })

  it('removes credentials from headers, bodies and captures of a copy', async () => {
    const { r } = await failingFlow()
    const clean = redactResults([r])[0] as RunResult
    const first = clean.steps[0] as RunResult['steps'][number]
    expect(first.response?.headers['set-cookie']).toBe('***')
    expect((first.response as any).body.access_token).toBe('***')
    expect(first.request?.headers.authorization).toBe('***')
    // the original is untouched
    expect(((r.steps[0] as any).response.body as any).access_token).toBe('tok_should_not_show')
    expect(JSON.stringify(clean)).not.toContain('tok_should_not_show')
  })
})

describe('traceLines', () => {
  it('shows the request and response, redacted, with the full address', async () => {
    const { r } = await failingFlow()
    const lines = traceLines(redactResults([r])[0]?.steps[0] as any, { origins })
    const text = lines.join('\n')
    expect(text).toContain('Request   GET https://api.example.test/pet/1')
    expect(text).toContain('authorization: ***')
    expect(text).toContain('Response  200 OK')
    expect(text).toContain('x-request-id: r-1')
    expect(text).not.toContain('set-cookie')
    expect(text).not.toContain('sk_live_123456')
  })

  it('cuts a long body', () => {
    const lines = traceLines(
      {
        name: 'x',
        kind: 'request',
        status: 'fail',
        assertions: [],
        captured: {},
        durationMs: 1,
        response: { status: 200, headers: {}, body: 'z'.repeat(5000), durationMs: 1 },
      },
      { maxBody: 100 },
    )
    expect(lines.at(-1)).toMatch(/… 4900 more characters/)
  })
})

describe('the list report', () => {
  it('prints a failure block: the diff, where it is, a source frame, the trace and how to re-run', async () => {
    const { r } = await failingFlow()
    const source = ['a', 'b', 'c', '  assert.equal(res.data, wrong)', 'e', 'f'].join('\n')
    const text = formatFailures(redactResults([r]), {
      origins,
      cwd: '/proj',
      readSource: () => source,
      rerun: (x) => `specbook test --env ${x.env} --grep "${x.title}"`,
    })
    expect(text).toContain('FAIL')
    expect(text).toContain('sequences/pets.seq.ts › Pets › Get pet 1')
    expect(text).toContain('✗ name is Rover')
    expect(text).toContain('- Expected')
    expect(text).toContain('-   "name": "Rover"')
    expect(text).toContain('+   "name": "Rex"')
    expect(text).toContain('Re-run: specbook test --env staging --grep "Pets"')
    expect(text).toContain('GET https://api.example.test/pet/1')
    // the implicit status check is described in words
    expect(text).toContain('- status 2xx')
    expect(text).toContain('+ status 404 Not Found')
    expect(text).not.toContain('tok_should_not_show')
    expect(text).not.toContain('sk_live_123456')
  })

  it('has no failure block for a clean run, and is quiet on request', async () => {
    const { transport } = fakeTransport(() => ({ status: 200, body: { id: '1', name: 'Rex' } }))
    const r = await runRequest(GetPet.request({ name: 'Ok', path: { id: '1' } }), {
      env: 'staging',
      transport,
      implicitStatusCheck: true,
    })
    expect(formatFailures([r])).toBe('')
    const all = formatList([r])
    expect(all).toContain('✓ Ok')
    expect(formatList([r], { quiet: true })).not.toContain('✓ Ok')
    expect(formatList([r], { quiet: true })).toContain('Flows')
  })

  it('lists the slowest steps one to a line, a request by its name alone', async () => {
    const { transport } = fakeTransport(() => ({ status: 200, body: { id: '1', name: 'Rex' } }))
    const run = (name: string, ms: number) =>
      runRequest(GetPet.request({ name, path: { id: '1' } }), {
        env: 'staging',
        transport,
        implicitStatusCheck: true,
      }).then((r) => ({
        ...r,
        steps: r.steps.map((s) => ({ ...s, durationMs: ms })),
      }))
    const text = formatList([await run('Get a country', 11), await run('List continents', 5)])
    const lines = text.split('\n')
    const at = lines.findIndex((l) => l.trim() === 'Slowest')
    expect(at).toBeGreaterThan(-1)
    expect(lines.slice(at + 1, at + 3).map((l) => l.trim())).toEqual([
      '11ms  Get a country',
      '5ms  List continents',
    ])
    // durations line up on their right edge
    expect(lines[at + 1]?.indexOf('Get a country')).toBe(lines[at + 2]?.indexOf('List continents'))
    // each on its own line, and the name is not repeated (`Get a country › Get a country`)
    expect(text).not.toContain('Get a country › Get a country')
  })

  it('summarizes flows, steps and assertions, flaky and errored included', async () => {
    const { r } = await failingFlow()
    const flaky = { ...r, status: 'pass', flaky: true, attempts: 2 } as RunResult
    const errored = { ...r, status: 'error' } as RunResult
    const text = formatSummary([r, flaky, errored], { durationMs: 1840 })
    expect(text).toMatch(/Flows\s+1 failed \| 1 errored \| 1 flaky \| 1 passed \(3\)/)
    expect(text).toContain('Duration    1.84s')
    expect(text).toMatch(/Assertions/)
  })

  it('streams a line per step as it finishes, then the failures and the summary', async () => {
    const { r, events } = await failingFlow()
    let out = ''
    const rep = createListReporter({ write: (s) => (out += s), origins })
    for (const e of events) rep.onEvent(e)
    expect(out).toContain('✗ Pets › Get pet 1  GET /pet/1  200')
    expect(out).toContain('✓ Pets › again')
    expect(out).not.toContain('FAIL')
    rep.onEnd([r])
    expect(out).toContain('FAIL')
    expect(out).toContain('Flows')
  })

  it('colors only when asked', async () => {
    const { r } = await failingFlow()
    expect(formatFailures([r])).not.toContain('\u001b[')
    expect(formatFailures([r], { colors: createColors(true) })).toContain('\u001b[31m')
    expect(colorEnabled({}, true)).toBe(true)
    expect(colorEnabled({ NO_COLOR: '1' }, true)).toBe(false)
    expect(colorEnabled({ FORCE_COLOR: '1' }, false)).toBe(true)
    expect(colorEnabled({ TERM: 'dumb' }, true)).toBe(false)
    // a CI log that renders color gets it, unless it was asked not to
    expect(colorEnabled({ GITHUB_ACTIONS: 'true' }, false)).toBe(true)
    expect(colorEnabled({ GITHUB_ACTIONS: 'true', NO_COLOR: '1' }, false)).toBe(false)
    expect(colorEnabled({}, false)).toBe(false)
    expect(colorEnabled({}, false)).toBe(false)
  })

  it('frames the source line with a caret', () => {
    const text = codeFrame('one\ntwo\nthree\nfour\nfive', 3, 4)
    expect(text.join('\n')).toContain('> 3 | three')
    expect(text.join('\n')).toContain('|    ^')
  })
})

describe('JUnit', () => {
  it('counts failures, errors and skips, and carries the trace and a flaky marker', async () => {
    const { r } = await failingFlow()
    const bad = {
      ...r,
      steps: [
        ...r.steps,
        { ...(r.steps[2] as any), name: 'boom', status: 'error', error: 'timeout of 30000ms' },
      ],
    } as RunResult
    const xml = toJUnit(redactResults([bad]), { origins, properties: { sha: 'abc123' } })
    expect(xml).toContain('<testsuite name="Pets" tests="4" failures="2" errors="1" skipped="0"')
    expect(xml).toContain('<property name="sha" value="abc123"/>')
    expect(xml).toContain('classname="sequences/pets.seq.ts"')
    expect(xml).toContain('name="Pets › Get pet 1"')
    expect(xml).toContain('<failure message="name is Rover" type="equal">')
    expect(xml).toContain('<error message="timeout of 30000ms" type="Error">')
    expect(xml).toContain('<system-out>')
    expect(xml).not.toContain('tok_should_not_show')
    expect(xml.match(/<testsuite /g)).toHaveLength(1)
    expect(xml.match(/<\/testsuite>/g)).toHaveLength(1)
    const flaky = toJUnit([
      { ...r, status: 'pass', flaky: true, attempts: 2, steps: [r.steps[2] as any] } as RunResult,
    ])
    expect(flaky).toContain('<flakyFailure message="passed on attempt 2"/>')
  })

  it('removes characters XML cannot hold', () => {
    const r = {
      title: 'x\u0001y',
      id: 'a',
      env: 'e',
      steps: [],
      totals: { steps: 0, passed: 0, failed: 0, skipped: 0, assertions: { passed: 0, failed: 0 } },
      startedAt: '',
      durationMs: 0,
    } as unknown as RunResult
    expect(toJUnit([r])).toContain('name="xy"')
  })
})

describe('GitHub', () => {
  it('annotates failures with escaped properties and repo-relative paths, and warns about a flaky flow', async () => {
    const { r } = await failingFlow()
    const located = JSON.parse(JSON.stringify(r)) as RunResult
    ;(located.steps[0] as any).assertions[0].location = {
      file: '/proj/requests/pet.req.ts',
      line: 12,
      column: 5,
    }
    const text = formatGithub([located, { ...located, flaky: true, attempts: 2, status: 'pass' }], {
      cwd: '/proj',
    })
    expect(text).toContain(
      '::error file=requests/pet.req.ts,line=12,title=Pets%3A Get pet 1::name is Rover',
    )
    expect(text).toContain(
      '::warning file=sequences/pets.seq.ts,title=Pets%3A flaky::passed on attempt 2',
    )
    expect(text).toMatch(/\d+\/2 runs passed$/)
  })

  it('writes a markdown summary', async () => {
    const { r } = await failingFlow()
    const md = githubSummary([r], { env: 'staging', runUrl: 'https://ci.example/run/1' })
    expect(md).toContain('### specbook test · staging')
    expect(md).toContain('| ❌ | Pets |')
    expect(md).toContain('#### Failures')
    expect(md).toContain('[Run](https://ci.example/run/1)')
  })
})

describe('the JSON report and CI detection', () => {
  it('wraps results with the run around them, and totals', async () => {
    const { r } = await failingFlow()
    const report = buildReport([r, { ...r, status: 'pass', flaky: true } as RunResult], {
      env: 'staging',
      specbook: '0.3.0',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:02.500Z',
    })
    expect(report.schemaVersion).toBe(2)
    expect(report.durationMs).toBe(2500)
    expect(report.totals.flows).toEqual({ passed: 1, failed: 1, errored: 0, flaky: 1 })
    expect(report.results).toHaveLength(2)
  })

  it('knows its CI provider', () => {
    expect(
      detectCi({
        GITHUB_ACTIONS: 'true',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'a/b',
        GITHUB_RUN_ID: '9',
        GITHUB_SHA: 'abc',
        GITHUB_REF_NAME: 'main',
      }),
    ).toEqual({
      provider: 'github-actions',
      runUrl: 'https://github.com/a/b/actions/runs/9',
      sha: 'abc',
      branch: 'main',
    })
    expect(detectCi({ GITLAB_CI: 'true', CI_PIPELINE_URL: 'u' })?.provider).toBe('gitlab-ci')
    expect(detectCi({ CI: '1' })).toEqual({ provider: 'ci' })
    expect(detectCi({})).toBeUndefined()
  })

  it('exits 1 for a failed or errored flow and 0 otherwise, flaky included', async () => {
    const { r } = await failingFlow()
    expect(testExitCode([r])).toBe(1)
    expect(testExitCode([{ ...r, status: 'error' } as RunResult])).toBe(1)
    expect(testExitCode([{ ...r, status: 'pass', flaky: true } as RunResult])).toBe(0)
  })
})
