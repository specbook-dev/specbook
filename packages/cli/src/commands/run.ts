import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type AuthProfile,
  collectSecretNames,
  createFetchTransport,
  createMockTransport,
  dotenvProvider,
  envProvider,
  exitCode,
  formatGithub,
  formatPretty,
  installFaker,
  MissingSecretsError,
  type PreparedRequest,
  type RequestDef,
  type RunEvent,
  type RunResult,
  resolveSecrets,
  runRequest,
  runSequence,
  type Sequence,
  type Transport,
  toJson,
  toJUnit,
} from '@specbook/core'
import { readEnvironment } from '@specbook/vite'
import fg from 'fast-glob'
import { exampleLoadersFor } from '../examples'
import type { Loader } from '../load'
import { type Project, readDotenv } from '../project'

export interface RunCommandOptions {
  patterns: string[]
  env: string
  params: Record<string, unknown>
  vars: Record<string, unknown>
  reporters: string[]
  secretsFile?: string
  tags: string[]
  locale?: string
  seed?: number
  notify?: string
}

type Runnable = RequestDef<any, any, any> | Sequence<any, any>

function isRunnable(v: unknown): v is Runnable {
  const k = (v as { kind?: string } | undefined)?.kind
  return k === 'request' || k === 'sequence'
}

function mockLoaderFor(project: Project) {
  const outDir = resolve(project.root, project.config.codegen?.outDir ?? '.generated')
  const manifests = new Map<string, Promise<{ operations: { id: string; statuses: number[] }[] }>>()
  const manifest = (service: string) => {
    let m = manifests.get(service)
    if (!m) {
      m = readFile(join(outDir, service, 'manifest.json'), 'utf8').then(JSON.parse)
      manifests.set(service, m)
    }
    return m
  }
  return {
    async statuses(service: string, opId: string) {
      const m = await manifest(service)
      return m.operations.find((o) => o.id === opId)?.statuses ?? []
    },
    async example(service: string, opId: string, status: number) {
      for (const name of [String(status), 'default']) {
        try {
          return JSON.parse(
            await readFile(
              join(outDir, service, 'examples', opId, `${name}.response.json`),
              'utf8',
            ),
          )
        } catch {
          /* fall back to the spec's default-response example */
        }
      }
      return undefined
    },
  }
}

export async function runCommand(
  project: Project,
  loader: Loader,
  o: RunCommandOptions,
): Promise<number> {
  const files = (
    await fg(o.patterns, {
      cwd: project.root,
      absolute: true,
      ignore: ['**/node_modules/**', '**/.generated/**'],
    })
  ).sort()
  if (files.length === 0) {
    console.error(`No files matched: ${o.patterns.join(', ')}`)
    return 3
  }

  const targets: Runnable[] = []
  for (const f of files) {
    const mod = await loader.import<Record<string, unknown>>(f)
    if (isRunnable(mod.default)) targets.push(mod.default)
    else for (const v of Object.values(mod)) if (isRunnable(v)) targets.push(v)
  }
  const selected = o.tags.length
    ? targets.filter((t) => t.kind === 'sequence' && t.meta.tags?.some((x) => o.tags.includes(x)))
    : targets
  if (selected.length === 0) {
    console.error('Nothing to run (no sequences or requests found, or no tag matched).')
    return 3
  }

  const config = project.config
  const auth = (config.auth ?? {}) as Record<string, AuthProfile>
  const serviceAuth = Object.fromEntries(
    Object.entries(config.services)
      .filter(([, s]) => s.auth)
      .map(([n, s]) => [n, s.auth as string]),
  )

  const examples = exampleLoadersFor(project)
  // `.specbook/environments/<env>.env` (variables) and `<env>.secrets.env` (secrets) for this run
  const envFiles = await readEnvironment(project.root, o.env)

  // the mock environment needs no secrets
  let secrets: Record<string, string> = {}
  if (o.env !== 'mock') {
    const needed = new Set<string>()
    for (const t of selected)
      for (const n of await collectSecretNames(t, auth, examples.example, serviceAuth))
        needed.add(n)
    const providers = [
      envProvider(process.env),
      ...(o.secretsFile
        ? [dotenvProvider(await readDotenv(resolve(o.secretsFile)), 'secrets-file')]
        : []),
      dotenvProvider(envFiles.secrets, `environments/${o.env}.secrets.env`),
      dotenvProvider(envFiles.shared, 'secrets.local.env'),
      ...(config.secretProviders ?? []),
    ]
    try {
      secrets = await resolveSecrets(needed, config.secrets ?? {}, providers)
    } catch (e) {
      if (e instanceof MissingSecretsError) {
        console.error(
          `Missing secrets for "${o.env}":\n  ${e.names.join('\n  ')}\n\n` +
            `Set them as environment variables, or in .specbook/environments/${o.env}.secrets.env ` +
            `(or .specbook/secrets.local.env to share across environments).`,
        )
        return 2
      }
      throw e
    }
  }

  let transport: Transport
  if (o.env === 'mock') {
    transport = createMockTransport({ loader: mockLoaderFor(project) })
  } else {
    const fetchT = createFetchTransport({
      baseUrl: (service) => {
        const url = config.services[service]?.baseUrl[o.env as 'live']
        if (!url) throw new Error(`No baseUrl for service "${service}" in env "${o.env}"`)
        return url
      },
    })
    transport = (req: PreparedRequest, signal) => fetchT(req, signal)
  }

  const vars = {
    ...(config.vars ?? {}),
    ...(config.environments?.[o.env]?.vars ?? {}),
    ...envFiles.vars,
  }

  // faker is a peer dependency of the project; only load it when it can be resolved
  let fakerModule: any
  try {
    const entry = createRequire(join(project.root, 'package.json')).resolve('@faker-js/faker')
    fakerModule = await import(pathToFileURL(entry).href)
  } catch {
    /* no faker in this project */
  }

  const ndjson = o.reporters.some((r) => r === 'ndjson' || r.startsWith('ndjson:'))
  const onEvent = ndjson
    ? (e: RunEvent) => {
        if (e.type !== 'done') process.stdout.write(`${JSON.stringify(e)}\n`)
      }
    : undefined
  const results: RunResult[] = []
  for (const t of selected) {
    if (fakerModule) installFaker(fakerModule, config.faker, { locale: o.locale, seed: o.seed })
    const opts = {
      env: o.env,
      vars,
      overrides: o.vars,
      params: o.params,
      transport,
      secrets,
      auth,
      serviceAuth,
      locale: o.locale,
      seed: o.seed,
      onEvent,
      example: examples.example,
      readFile: examples.readFile,
    }
    results.push(t.kind === 'sequence' ? await runSequence(t, opts) : await runRequest(t, opts))
  }

  for (const spec of o.reporters.length ? o.reporters : ['pretty']) {
    const [kind, path] = spec.split(/:(.*)/s) as [string, string | undefined]
    if (kind === 'ndjson') continue // already streamed
    const text =
      kind === 'json'
        ? toJson(results)
        : kind === 'junit'
          ? toJUnit(results)
          : kind === 'github'
            ? formatGithub(results)
            : formatPretty(results)
    if (path) await writeFile(resolve(path), `${text}\n`)
    else console.log(text)
  }

  const code = exitCode(results)
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
