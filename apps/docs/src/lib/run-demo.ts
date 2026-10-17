// Runs the demo's requests and flows the way `specbook test` does, in a page: the same suite loop and the same list
// reporter, writing colored text instead of a process's stdout. Pure apart from the `fetch` it is given.

import {
  absoluteBase,
  baseUrlFor,
  createColors,
  createFetchTransport,
  createListReporter,
  environmentScope,
  headerLine,
  parseDotenv,
  type RequestDef,
  type RunEvent,
  retryLine,
  runSuite,
  type Sequence,
  type SpecbookConfig,
  testExitCode,
  withoutLocations,
} from '@specbook/core'

export type Runnable = RequestDef<any, any, any> | Sequence<any, any>

export interface DemoRun {
  config: SpecbookConfig
  /** the modules to run, as `import()` gave them */
  modules: { file: string; mod: Record<string, unknown> }[]
  env: string
  /** the text of the environment's file */
  envText: string
  retries?: number
  /** only runs whose title contains this, case-insensitively */
  grep?: string
  fetch: typeof fetch
  pageHref: string
  /** shown in the header line */
  version: string
  write(text: string): void
}

const isRunnable = (v: unknown): v is Runnable => {
  const k = (v as { kind?: string } | undefined)?.kind
  return k === 'request' || k === 'sequence'
}
const titleOf = (r: Runnable) => (r.kind === 'sequence' ? r.meta.title : (r.input.name ?? r.op.id))
const tagsOf = (r: Runnable): string[] =>
  r.kind === 'sequence' ? (r.meta.tags ?? []) : (r.input.tags ?? [])

/** Runs and prints; resolves to the exit code `specbook test` would give. */
export async function runDemo(o: DemoRun): Promise<number> {
  const colors = createColors(true)
  const all = o.modules.flatMap(({ file, mod }) =>
    (isRunnable(mod.default) ? [mod.default] : Object.values(mod).filter(isRunnable)).map(
      (run) => ({
        run,
        file,
        title: titleOf(run),
        tags: tagsOf(run),
      }),
    ),
  )
  const grep = o.grep?.toLowerCase()
  const picked = grep ? all.filter((t) => t.title.toLowerCase().includes(grep)) : all
  const vars = environmentScope(o.config, o.env, parseDotenv(o.envText))
  const base = (service: string) => {
    const url = baseUrlFor(o.config, service, o.env, vars)
    if (!url) throw new Error(`No baseUrl for service "${service}" in env "${o.env}"`)
    return absoluteBase(url, o.pageHref)
  }
  const origins: Record<string, string> = {}
  for (const service of Object.keys(o.config.services)) {
    try {
      origins[service] = new URL(base(service)).origin
    } catch {
      /* a call says so */
    }
  }
  const transport = createFetchTransport({ baseUrl: base, fetch: o.fetch })
  const reporter = createListReporter({ colors, origins, write: o.write })

  o.write(
    headerLine(
      { version: o.version, env: o.env, picked: picked.length, total: all.length },
      colors,
    ),
  )
  const { results, notRun, stopped } = await runSuite(picked, {
    run: {
      env: o.env,
      vars,
      transport: (req, signal) => transport({ ...req, timeoutMs: req.timeoutMs ?? 30_000 }, signal),
      onEvent: (e: RunEvent) => reporter.onEvent(e),
      implicitStatusCheck: true,
    },
    retries: o.retries,
    onRetry: (t, attempt, allowed) => o.write(retryLine(colors, t.title, attempt, allowed)),
  })
  reporter.onEnd(withoutLocations(results))
  if (stopped) o.write(`${colors.yellow(stopped)}${notRun ? `: ${notRun} not run` : ''}\n`)
  return stopped ? 1 : testExitCode(results)
}
