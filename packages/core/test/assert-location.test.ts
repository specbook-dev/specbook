import { describe, expect, it } from 'vitest'
import { locate } from '../src/assert'

describe('where an assertion was made', () => {
  it('is the first frame outside the helper, whether the helper is core source or a bundled CLI', () => {
    const source = [
      'Error',
      '    at /repo/packages/core/src/assert.ts:41:20',
      '    at /repo/apps/example/requests/get-order.req.ts:9:14',
      '    at async run (/repo/packages/core/src/runner/run.ts:300:5)',
    ].join('\n')
    expect(locate(source)).toEqual({
      file: '/repo/apps/example/requests/get-order.req.ts',
      line: 9,
      column: 14,
    })
    // everything the CLI is made of is one file, so the frames of the helper are in that file too
    const bundled = [
      'Error',
      '    at file:///proj/node_modules/@specbook/cli/dist/bin.js:1886:28',
      '    at file:///proj/node_modules/@specbook/cli/dist/bin.js:1890:5',
      '    at /proj/requests/get-order.req.ts:9:14',
      '    at async file:///proj/node_modules/@specbook/cli/dist/bin.js:2200:9',
    ].join('\n')
    expect(locate(bundled)).toEqual({
      file: '/proj/requests/get-order.req.ts',
      line: 9,
      column: 14,
    })
    expect(locate(undefined)).toBeUndefined()
  })
})
