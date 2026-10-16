// Instrumented uvu/assert: every call is recorded as pass/fail. Soft mode swallows failures.
import * as uvu from 'uvu/assert'
import type { Assert, AssertionResult, AssertMode } from './types'

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
const ANSI = /\u001b\[[0-9;]*m/g
export const stripAnsi = (s: string) => s.replace(ANSI, '')

/** Plain uvu/assert, for use outside a run. */
export const assert = uvu as unknown as Assert

const FRAME = /(?:\(|at )?([^\s()]+):(\d+):(\d+)\)?\s*$/

/**
 * Where in the user's code an assertion was made: the first frame of the stack that is not this helper. Run from source
 * the helper is `core/src/assert`; inside a bundled CLI it is the bundle itself, so any frame in the file the stack starts
 * in is the helper too.
 */
export function locate(stack: string | undefined): AssertionResult['location'] {
  if (!stack) return undefined
  const frames = stack
    .split('\n')
    .slice(1)
    .map((line) => ({ line, m: FRAME.exec(line) }))
  const own = frames[0]?.m?.[1]
  for (const { line, m } of frames) {
    if (!m || line.includes('/core/src/assert') || line.includes('node_modules')) continue
    if (m[1] === own) continue
    return { file: m[1] as string, line: Number(m[2]), column: Number(m[3]) }
  }
  return undefined
}

export interface Asserter {
  assert: Assert
  results: AssertionResult[]
}

export function createAsserter(mode: AssertMode = 'soft'): Asserter {
  const results: AssertionResult[] = []

  const wrap = (name: string, fn: (...a: any[]) => void) => {
    const msgIndex = fn.length - 1
    return (...args: any[]) => {
      const given = typeof args[msgIndex] === 'string' ? (args[msgIndex] as string) : undefined
      try {
        fn(...args)
        results.push({
          label: given ?? name,
          operator: name,
          pass: true,
          location: locate(new Error().stack),
        })
      } catch (e: any) {
        if (e?.name !== 'Assertion') throw e
        results.push({
          label: stripAnsi(String(e.message ?? given ?? name)),
          operator: name,
          pass: false,
          actual: e.actual,
          expected: e.expects,
          diff: e.details ? stripAnsi(String(e.details)) : undefined,
          location: locate(new Error().stack),
        })
        if (mode === 'hard') throw e
      }
    }
  }

  const u = uvu as unknown as Record<string, any>
  const out: Record<string, any> = {}
  for (const key of [
    'ok',
    'is',
    'equal',
    'type',
    'instance',
    'match',
    'throws',
    'unreachable',
    'snapshot',
    'fixture',
  ]) {
    if (typeof u[key] === 'function') out[key] = wrap(key, u[key])
  }
  const not = wrap('not', u.not)
  for (const key of Object.keys(u.not ?? {})) {
    if (typeof u.not[key] === 'function') (not as any)[key] = wrap(`not.${key}`, u.not[key])
  }
  out.not = not
  return { assert: out as Assert, results }
}
