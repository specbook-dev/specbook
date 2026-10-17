// The flags of a test run and how they become options; `specbook test` and a compiled bundle accept the same ones.

import type { TestCommandOptions } from './run-tests'

export class UsageError extends Error {}

export const TEST_FLAGS = {
  env: { type: 'string', default: 'mock' },
  input: { type: 'string', multiple: true },
  var: { type: 'string', multiple: true },
  tag: { type: 'string', multiple: true },
  reporter: { type: 'string', multiple: true },
  'secrets-file': { type: 'string' },
  locale: { type: 'string' },
  seed: { type: 'string' },
  notify: { type: 'string' },
  grep: { type: 'string' },
  'grep-invert': { type: 'string' },
  list: { type: 'boolean' },
  shard: { type: 'string' },
  bail: { type: 'string' },
  retries: { type: 'string' },
  timeout: { type: 'string' },
  'global-timeout': { type: 'string' },
  safe: { type: 'boolean' },
  trace: { type: 'string' },
  quiet: { type: 'boolean' },
} as const

/** The flags as help text, indented for a command's own listing. */
export const TEST_HELP = `      --env <name>             environment (default: mock, for development)
      --tag <tag>              only requests/flows with this tag (repeatable)
      --grep <re> --grep-invert <re>   select by file or title
      --list                   print what would run
      --shard <i/n>            run the i-th of n equal parts
      --bail <n>               stop after n failed flows
      --retries <n>            run a failed flow again up to n times (a pass is "flaky")
      --timeout <ms>           per request (default: the config's timeoutMs, else 30000; 0 waits)
      --global-timeout <ms>    the whole run
      --safe                   refuse requests that may change data (use against production)
      --reporter <r[:path]>    list (default) | json | junit | github | ndjson (repeatable)
      --trace <when>           on-failure (default) | always | off: the request and response of a step
      --quiet                  only failures and the summary
      --input k=v              flow input value (repeatable)
      --var k=v                variable override (repeatable)
      --secrets-file <path>    dotenv file with secrets
      --locale <l> --seed <n>  synthetic data locale / deterministic seed
      --notify <url>           POST a summary to a webhook when something fails`

const parseValue = (v: string): unknown => {
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}
const kv = (list: string[] = []) =>
  Object.fromEntries(
    list.map((s) => {
      const i = s.indexOf('=')
      return [s.slice(0, i), parseValue(s.slice(i + 1))]
    }),
  )

type Values = Record<string, string | boolean | string[] | undefined>

const number = (name: string, v: unknown) => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} takes a number, got "${v}"`)
  return n
}

/** The options of a run from parsed flags; throws UsageError for a flag that cannot be used. */
export function testOptions(values: Values, patterns: string[]): TestCommandOptions {
  if (values.trace && !['on-failure', 'always', 'off'].includes(values.trace as string))
    throw new UsageError('--trace takes on-failure, always or off')
  return {
    patterns,
    env: values.env as string,
    inputs: kv(values.input as string[] | undefined),
    vars: kv(values.var as string[] | undefined),
    reporters: (values.reporter as string[] | undefined) ?? [],
    secretsFile: values['secrets-file'] as string | undefined,
    tags: (values.tag as string[] | undefined) ?? [],
    grep: values.grep as string | undefined,
    grepInvert: values['grep-invert'] as string | undefined,
    list: values.list as boolean | undefined,
    shard: values.shard as string | undefined,
    bail: number('bail', values.bail),
    retries: number('retries', values.retries),
    timeoutMs: number('timeout', values.timeout),
    globalTimeoutMs: number('global-timeout', values['global-timeout']),
    safe: values.safe as boolean | undefined,
    trace: values.trace as 'on-failure' | 'always' | 'off' | undefined,
    quiet: values.quiet as boolean | undefined,
    locale: values.locale as string | undefined,
    seed: values.seed ? Number(values.seed) : undefined,
    notify: values.notify as string | undefined,
  }
}
