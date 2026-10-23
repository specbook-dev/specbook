// Running requests and flows and reporting like a test runner. It needs only what a run itself needs, handed in as a
// TestContext, so `specbook test` (a project on disk) and a standalone bundle (everything compiled in) share it. Nothing
// here may import the Vite loader, the globber or the spec tooling: the bundle would carry them.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import {
  type AuthProfile,
  baseUrlFor,
  buildReport,
  collectSecretNames,
  colorEnabled,
  createColors,
  createFetchTransport,
  createListReporter,
  createMockTransport,
  detectCi,
  dotenvProvider,
  type ExampleLoader,
  environmentScope,
  envProvider,
  type FileReader,
  formatGithub,
  formatList,
  githubSummary,
  headerLine,
  installFaker,
  MissingSecretsError,
  maskDeep,
  oauthFor,
  profileOfAuthService,
  type RequestDef,
  type RunEvent,
  type RunResult,
  redactEvent,
  redactResults,
  resolveSecrets,
  retryLine,
  runSuite,
  type Sequence,
  type SpecbookConfig,
  serviceProfiles,
  type Transport,
  testExitCode,
  toJUnit,
  withoutLocations,
} from '@specbook/core'
import { readDotenv } from './project'
import { cliVersion } from './version'

export type Runnable = RequestDef<any, any, any> | Sequence<any, any>

/** A request or flow with the project file it comes from (relative to the project). */
export interface Target {
  run: Runnable
  file: string
  title: string
  tags: string[]
}

export const titleOf = (r: Runnable) =>
  r.kind === 'sequence' ? r.meta.title : (r.input.name ?? r.op.id)
export const tagsOf = (r: Runnable): string[] =>
  r.kind === 'sequence' ? (r.meta.tags ?? []) : (r.input.tags ?? [])

function isRunnable(v: unknown): v is Runnable {
  const k = (v as { kind?: string } | undefined)?.kind
  return k === 'request' || k === 'sequence'
}

/** The requests and flows a module exports: its default, or else each export that is one. */
export function targetsOf(mod: Record<string, unknown>, file: string): Target[] {
  const found = isRunnable(mod.default) ? [mod.default] : Object.values(mod).filter(isRunnable)
  return found.map((run) => ({ run, file, title: titleOf(run), tags: tagsOf(run) }))
}

export type MockLoader = Parameters<typeof createMockTransport>[0]['loader']

/** What a run reads from the environment files of an environment. */
export interface EnvironmentValues {
  vars: Record<string, string>
  secrets: Record<string, string>
  shared: Record<string, string>
}

/** Everything a run needs, however it was found. */
export interface TestContext {
  /** how a run is started, for the re-run hint under a failure */
  command: string
  /** where relative paths and the git lookup start */
  root: string
  config: SpecbookConfig
  /** every request and flow that can run, before any selection */
  targets: Target[]
  /** environments that can be named with --env */
  environments: string[]
  readEnvironment(env: string): Promise<EnvironmentValues>
  examples: { example: ExampleLoader; readFile: FileReader }
  /** mock responses; only a development checkout has them */
  mock?: MockLoader
  loadFaker(): Promise<any>
  /** set when the tests were built into a bundle */
  bundle?: { sha?: string; createdAt: string }
  git?: { sha?: string; branch?: string }
  /** source text for code frames under a failure; a bundle has none */
  readSource?: (file: string) => string | undefined
  /** drop the file:line of an assertion, which in a bundle points into the bundled file */
  hideLocations?: boolean
  /** secrets may also be in environment files (a project on disk); a bundle has the environment only */
  secretFiles?: boolean
}

export interface TestCommandOptions {
  /** files or globs; the project's requests and sequences when none are given */
  patterns: string[]
  env: string
  inputs: Record<string, unknown>
  vars: Record<string, unknown>
  /** `name` or `name:path`: list, json, junit, github, ndjson */
  reporters: string[]
  secretsFile?: string
  tags: string[]
  grep?: string
  grepInvert?: string
  list?: boolean
  /** `i/n`: run the i-th of n equal parts of the selected flows */
  shard?: string
  /** stop after this many flows failed */
  bail?: number
  /** run a failed flow again up to this many times; passing on a retry is flaky */
  retries?: number
  /** per request, default 30 000 */
  timeoutMs?: number
  /** the whole run */
  globalTimeoutMs?: number
  /** refuse any request that may change data: for production, where a run must only look */
  safe?: boolean
  trace?: 'on-failure' | 'always' | 'off'
  quiet?: boolean
  locale?: string
  seed?: number
  notify?: string
}

const KINDS = ['list', 'json', 'junit', 'github', 'ndjson'] as const
type Kind = (typeof KINDS)[number]

function gitInfo(root: string): { sha?: string; branch?: string } {
  const git = (...args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    } catch {
      return undefined
    }
  }
  return {
    sha: git('rev-parse', '--short', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  }
}

const quote = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function parseShard(s: string): { index: number; total: number } | undefined {
  const m = /^(\d+)\/(\d+)$/.exec(s)
  if (!m) return undefined
  const [index, total] = [Number(m[1]), Number(m[2])]
  return index >= 1 && total >= 1 && index <= total ? { index, total } : undefined
}

function select(targets: Target[], o: TestCommandOptions): Target[] | string {
  let out = targets
  if (o.tags.length) out = out.filter((t) => t.tags.some((x) => o.tags.includes(x)))
  try {
    if (o.grep) {
      const re = new RegExp(o.grep, 'i')
      out = out.filter((t) => re.test(`${t.file} ${t.title}`))
    }
    if (o.grepInvert) {
      const re = new RegExp(o.grepInvert, 'i')
      out = out.filter((t) => !re.test(`${t.file} ${t.title}`))
    }
  } catch (e) {
    return `Bad --grep expression: ${e instanceof Error ? e.message : e}`
  }
  if (o.shard) {
    const shard = parseShard(o.shard)
    if (!shard) return `Bad --shard "${o.shard}": use i/n, for example 1/3`
    out = out.filter((_, i) => i % shard.total === shard.index - 1)
  }
  return out
}

const authOf = (config: SpecbookConfig) => (config.auth ?? {}) as Record<string, AuthProfile>

const serviceAuthOf = (config: SpecbookConfig) =>
  Object.fromEntries(
    Object.entries(config.services)
      .filter(([, s]) => serviceProfiles(s).length)
      .map(([n, s]) => [n, serviceProfiles(s)]),
  )

/**
 * The secrets the targets use, from the environment first, then a file given, the environment's own secrets file and
 * the shared one. Throws MissingSecretsError naming the ones nobody has.
 */
async function resolveRunSecrets(
  ctx: TestContext,
  targets: Runnable[],
  env: string,
  files: EnvironmentValues,
  secretsFile?: string,
): Promise<Record<string, string>> {
  const needed = new Set<string>()
  for (const t of targets)
    for (const n of await collectSecretNames(
      t,
      authOf(ctx.config),
      ctx.examples.example,
      serviceAuthOf(ctx.config),
    ))
      needed.add(n)
  const providers = [
    envProvider(process.env),
    ...(secretsFile
      ? [dotenvProvider(await readDotenv(resolve(secretsFile)), 'secrets-file')]
      : []),
    dotenvProvider(files.secrets, `environments/${env}.secrets.env`),
    dotenvProvider(files.shared, 'secrets.local.env'),
    ...(ctx.config.secretProviders ?? []),
  ]
  return resolveSecrets(needed, ctx.config.secrets ?? {}, providers)
}

function missingSecretsMessage(e: MissingSecretsError, env: string, files: boolean): string {
  const list = `Missing secrets for "${env}":\n  ${e.names.join('\n  ')}\n\n`
  return files
    ? `${list}Set them as environment variables, or in .specbook/environments/${env}.secrets.env ` +
        '(or .specbook/secrets.local.env to share across environments).'
    : `${list}Set them as environment variables.`
}

/** A transport for the environment: mock responses for `mock`, else the addresses its variables give. */
function transportFor(ctx: TestContext, env: string, vars: Record<string, unknown>): Transport {
  if (env === 'mock') return createMockTransport({ loader: ctx.mock as MockLoader })
  return createFetchTransport({
    baseUrl: (service) => {
      // a token request is made as the reserved service `auth:<profile>`: its origin is the profile's token endpoint
      const profile = profileOfAuthService(service)
      if (profile !== undefined) {
        const oauth = (ctx.config.auth?.[profile] as AuthProfile | undefined)?.oauth
        if (!oauth || !('tokenUrl' in oauth) || !oauth.tokenUrl)
          throw new Error(`Profile "${profile}" has no token endpoint`)
        return new URL(oauthFor(oauth, vars, profile).tokenUrl as string).origin
      }
      const url = baseUrlFor(ctx.config, service, env, vars)
      if (!url) throw new Error(`No baseUrl for service "${service}" in env "${env}"`)
      return url
    },
  })
}

/**
 * The address each service's calls go to in `env`: its origin for the report, or with `basePath` the origin and the base
 * path, which is what a trace shows. Services with no address are left out.
 */
function originsFor(
  config: SpecbookConfig,
  env: string,
  vars: Record<string, unknown>,
  basePath = false,
): Record<string, string> {
  if (env === 'mock') return {}
  const out: Record<string, string> = {}
  for (const service of Object.keys(config.services)) {
    try {
      const url = baseUrlFor(config, service, env, vars)
      if (url) {
        const u = new URL(url)
        out[service] = basePath ? `${u.origin}${u.pathname.replace(/\/+$/, '')}` : u.origin
      }
    } catch {
      /* no usable address here: a call says so */
    }
  }
  return out
}

/**
 * Runs the requests and flows against an environment and reports like a test runner: each step as it finishes, what
 * failed and why, a summary, and machine-readable reports. It never generates code and never reads a spec.
 * Exit: 0 every flow passed (a flaky one counts), 1 any failed or errored, 2 it could not run, 3 usage.
 */
export async function runTests(ctx: TestContext, o: TestCommandOptions): Promise<number> {
  const specs = (o.reporters.length ? o.reporters : ['list']).map((s) => {
    const [kind, path] = s.split(/:(.*)/s) as [string, string | undefined]
    return { kind: kind as Kind, path }
  })
  const bad = specs.find((s) => !KINDS.includes(s.kind))
  if (bad) {
    console.error(`Unknown reporter "${bad.kind}". Use: ${KINDS.join(', ')}`)
    return 3
  }
  if (process.env.GITHUB_ACTIONS === 'true' && !specs.some((s) => s.kind === 'github'))
    specs.push({ kind: 'github', path: undefined })

  if (!ctx.environments.includes(o.env)) {
    console.error(`Unknown environment "${o.env}". Known: ${ctx.environments.join(', ')}`)
    return 3
  }

  const picked = select(ctx.targets, o)
  if (typeof picked === 'string') {
    console.error(picked)
    return 3
  }
  if (picked.length === 0) {
    console.error(
      'Nothing to run: no request or flow found, or none matched --tag, --grep or --shard.',
    )
    return 3
  }

  if (o.list) {
    for (const t of picked)
      console.log(`${t.file} › ${t.title}${t.tags.length ? `  [${t.tags.join(', ')}]` : ''}`)
    console.log(`\n${picked.length} ${picked.length === 1 ? 'test' : 'tests'}`)
    return 0
  }

  if (o.env === 'mock' && !ctx.mock) {
    console.error(
      'The mock environment is for development, where the generated examples are. Test a real environment (--env <name>).',
    )
    return 2
  }

  const envFiles = await ctx.readEnvironment(o.env)
  let secrets: Record<string, string> = {}
  if (o.env !== 'mock') {
    try {
      secrets = await resolveRunSecrets(
        ctx,
        picked.map((t) => t.run),
        o.env,
        envFiles,
        o.secretsFile,
      )
    } catch (e) {
      if (e instanceof MissingSecretsError) {
        console.error(missingSecretsMessage(e, o.env, ctx.secretFiles !== false))
        return 2
      }
      throw e
    }
  }

  try {
    return await execute(ctx, o, picked, specs, envFiles.vars, secrets)
  } catch (e) {
    // an error message can carry a secret (an address with a key in its query): mask it like everything else
    console.error(maskDeep(e instanceof Error ? e.message : String(e), Object.values(secrets)))
    return 2
  }
}

async function execute(
  ctx: TestContext,
  o: TestCommandOptions,
  picked: Target[],
  specs: { kind: Kind; path?: string }[],
  fileVars: Record<string, string>,
  secrets: Record<string, string>,
): Promise<number> {
  const config = ctx.config
  const total = ctx.targets.length
  // `--var` overrides a variable everywhere, an address included: it layers over the environment's own files
  const given = Object.fromEntries(
    Object.entries(o.vars).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
  )
  const vars = environmentScope(config, o.env, { ...fileVars, ...given })
  const transport = transportFor(ctx, o.env, vars)
  const origins = originsFor(config, o.env, vars)
  const addresses = originsFor(config, o.env, vars, true)
  const faker = await ctx.loadFaker()
  const git = { ...(ctx.git ?? gitInfo(ctx.root)) }
  const ci = detectCi(process.env)
  if (ci?.sha) git.sha = ci.sha.slice(0, 7)
  if (ci?.branch) git.branch = ci.branch

  const bundle = ctx.bundle
  const colors = createColors(colorEnabled(process.env, !!process.stdout.isTTY))
  const readSource =
    ctx.readSource ??
    ((file: string) => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
    })
  const listOptions = {
    colors,
    quiet: o.quiet,
    trace: o.trace,
    origins: addresses,
    cwd: ctx.root,
    readSource,
    rerun: (r: RunResult) =>
      `${ctx.command}${r.file && ctx.command === 'specbook test' ? ` ${r.file}` : ''} --env ${o.env} --grep ${quote(escapeRegExp(r.title))}${o.safe ? ' --safe' : ''}`,
  }

  const startedAt = new Date()
  const list = specs.find((s) => s.kind === 'list')
  const streaming =
    list && !list.path
      ? createListReporter({ ...listOptions, write: (s) => process.stdout.write(s) })
      : undefined
  const ndjson = specs.find((s) => s.kind === 'ndjson')
  const ndjsonLines: string[] = []
  let flow = ''
  const onEvent = (e: RunEvent) => {
    streaming?.onEvent(e)
    if (e.type === 'run:start') flow = e.title ?? e.id
    if (ndjson && e.type !== 'done') {
      const line = JSON.stringify({ ts: new Date().toISOString(), flow, ...redactEvent(e) })
      if (ndjson.path) ndjsonLines.push(line)
      else process.stdout.write(`${line}\n`)
    }
  }

  if (streaming && !o.quiet) {
    const where = [
      git.branch && git.sha ? `${git.branch}@${git.sha}` : (git.sha ?? ''),
      bundle
        ? ['bundle', bundle.sha, `built ${bundle.createdAt.slice(0, 10)}`].filter(Boolean).join(' ')
        : '',
    ].filter(Boolean)
    process.stdout.write(
      headerLine(
        { version: cliVersion(), env: o.env, picked: picked.length, total, where },
        colors,
      ),
    )
  }

  const { results, notRun, stopped } = await runSuite(picked, {
    run: {
      env: o.env,
      vars,
      overrides: o.vars,
      inputs: o.inputs,
      transport,
      secrets,
      auth: authOf(config),
      serviceAuth: serviceAuthOf(config),
      locale: o.locale,
      seed: o.seed,
      onEvent,
      example: ctx.examples.example,
      readFile: ctx.examples.readFile,
      readOnly: o.safe === true,
      implicitStatusCheck: true,
      // the flag, else the project's own, else the runner's 30 seconds
      timeoutMs: o.timeoutMs ?? config.timeoutMs,
    },
    retries: o.retries,
    bail: o.bail,
    globalTimeoutMs: o.globalTimeoutMs,
    beforeAttempt: () => {
      if (faker) installFaker(faker, config.faker, { locale: o.locale, seed: o.seed })
    },
    onRetry: (t, attempt, allowed) => {
      if (streaming) process.stdout.write(retryLine(colors, t.title, attempt, allowed))
      if (ndjson && !ndjson.path)
        process.stdout.write(
          `${JSON.stringify({ ts: new Date().toISOString(), type: 'retry', flow: t.title, attempt })}\n`,
        )
    },
  })
  const finishedAt = new Date()

  const meta = {
    env: o.env,
    specbook: cliVersion(),
    node: process.version,
    os: `${process.platform}-${process.arch}`,
    git: git.sha || git.branch ? git : undefined,
    ci,
    bundle: bundle ? { sha: bundle.sha, createdAt: bundle.createdAt } : undefined,
    services: origins,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  }
  const clean = redactResults(ctx.hideLocations ? withoutLocations(results) : results)
  const write = async (path: string | undefined, text: string) => {
    if (!path) return process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
    await mkdir(dirname(resolve(path)), { recursive: true })
    await writeFile(resolve(path), text.endsWith('\n') ? text : `${text}\n`)
  }
  for (const s of specs) {
    if (s.kind === 'list') {
      if (streaming) streaming.onEnd(clean)
      else
        await write(
          s.path,
          formatList(clean, {
            ...listOptions,
            colors: createColors(false),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
          }),
        )
    } else if (s.kind === 'json') {
      await write(s.path, JSON.stringify(buildReport(clean, meta), null, 2))
    } else if (s.kind === 'junit') {
      await write(
        s.path,
        toJUnit(clean, {
          timestamp: meta.startedAt,
          hostname: hostname(),
          origins: addresses,
          properties: { env: o.env, sha: git.sha, branch: git.branch, specbook: meta.specbook },
        }),
      )
    } else if (s.kind === 'github') {
      await write(s.path, formatGithub(clean, { cwd: ctx.root }))
      const summary = process.env.GITHUB_STEP_SUMMARY
      if (summary && process.env.GITHUB_ACTIONS === 'true')
        appendFileSync(summary, githubSummary(clean, { env: o.env, runUrl: ci?.runUrl }))
    } else if (s.kind === 'ndjson' && s.path) {
      const totals = buildReport(clean, meta).totals
      ndjsonLines.push(JSON.stringify({ ts: meta.finishedAt, type: 'summary', totals }))
      await write(s.path, ndjsonLines.join('\n'))
    }
  }
  if (ndjson && !ndjson.path) {
    process.stdout.write(
      `${JSON.stringify({ ts: meta.finishedAt, type: 'summary', totals: buildReport(clean, meta).totals })}\n`,
    )
  }
  if (stopped) console.error(`${colors.yellow(stopped)}${notRun ? `: ${notRun} not run` : ''}`)

  const code = stopped ? 1 : testExitCode(results)
  if (o.notify && code !== 0) {
    const failed = results.filter((r) => r.status !== 'pass')
    try {
      await fetch(o.notify, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `specbook: ${failed.length}/${results.length} runs failed in ${o.env}: ${failed.map((r) => r.title).join(', ')}`,
          env: o.env,
          failed: failed.map((r) => ({
            id: r.id,
            title: r.title,
            status: r.status,
            totals: r.totals,
          })),
        }),
      })
    } catch (e) {
      console.error(`notify failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  return code
}
