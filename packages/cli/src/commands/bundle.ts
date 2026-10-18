import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type Example, fakerLocaleExports } from '@specbook/core'
import { listEnvironmentFiles, readEnvironment, requestsDirFor } from '@specbook/vite'
import { type Plugin, rolldown } from 'rolldown'
import { USES_FAKER } from '../faker-use'
import type { Loader } from '../load'
import { unknownOperationsMessage, usedMetadata } from '../ops'
import type { Project } from '../project'
import { discoverTargets } from '../runtime'
import { cliVersion } from '../version'

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const posix = (p: string) => p.split(sep).join('/')

export interface BundleOptions {
  /** the file to write */
  out: string
  /** keep only the requests and flows with one of these tags */
  tags: string[]
  /** packages to leave as imports instead of compiling in; they must be installed where the file runs */
  external?: string[]
}

const ENTRY = '\0specbook:entry'
const FAKER = '\0specbook:faker'

function git(root: string): { sha?: string; branch?: string } {
  const run = (...args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    } catch {
      return undefined
    }
  }
  return {
    sha: run('rev-parse', '--short', 'HEAD'),
    branch: run('rev-parse', '--abbrev-ref', 'HEAD'),
  }
}

/** The runner a bundle is built around: next to this file when built, in `src` when run from source. */
function standalonePath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const p of [
    join(here, 'standalone.js'),
    join(here, '..', 'standalone.js'),
    join(here, '..', 'standalone.ts'),
  ])
    if (existsSync(p)) return p
  throw new Error('The test runner is missing from this installation of specbook')
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return (
    await Promise.all(
      entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])),
    )
  ).flat()
}

const SKIP = /(^|\/)(node_modules|\.generated|\.git|dist|dist-[^/]+)(\/|$)/
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|md)$/

interface Embedded {
  examples: Record<string, { doc: Example; source: 'project' | 'generated'; dir: string }>
  files: Record<string, string>
  bytes: number
}

/**
 * The examples requests name (`example: 'country'`) and the files they upload, read now so the bundle needs no disk at run
 * time. A project's own `*.example.json` wins over a generated one, as it does for `specbook test`.
 */
async function embed(
  project: Project,
  outDir: string,
  used: Record<string, Record<string, unknown>>,
): Promise<Embedded> {
  const root = project.root
  const out: Embedded = { examples: {}, files: {}, bytes: 0 }
  const read = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as Example
  for (const [service, ops] of Object.entries(used))
    for (const id of Object.keys(ops)) {
      const dir = join(outDir, service, 'examples', id)
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        const m = /^(.+)\.example\.json$/.exec(f)
        if (!m) continue
        out.examples[`${service}/${id}/${m[1]}`] = {
          doc: await read(join(dir, f)),
          source: 'generated',
          dir: '',
        }
      }
    }
  const folders = new Set<string>()
  for (const abs of await walk(root)) {
    const rel = posix(relative(root, abs))
    if (SKIP.test(rel)) continue
    const m = /(?:^|\/)([^/]+)\/([^/]+)\/([^/]+)\.example\.json$/.exec(rel)
    if (!m) continue
    const [, service, id, name] = m as unknown as [string, string, string, string]
    if (!used[service]?.[id]) continue
    out.examples[`${service}/${id}/${name}`] = {
      doc: await read(abs),
      source: 'project',
      dir: posix(dirname(rel)),
    }
    folders.add(dirname(abs))
  }
  // what an example uploads sits beside it
  for (const folder of folders)
    for (const abs of await walk(folder)) {
      const rel = posix(relative(root, abs))
      if (SKIP.test(rel) || CODE.test(rel) || rel.endsWith('.example.json')) continue
      const data = await readFile(abs)
      out.files[rel] = data.toString('base64')
      out.bytes += data.length
    }
  return out
}

/** The faker locales the config can reach, as the named exports a bundle needs from `@faker-js/faker`. */
async function fakerSource(project: Project): Promise<string | undefined> {
  let entry: string
  try {
    entry = createRequire(join(project.root, 'package.json')).resolve('@faker-js/faker')
  } catch {
    return undefined
  }
  const cfg = project.config.faker ?? {}
  const wanted = new Set(['Faker', ...fakerLocaleExports(cfg)])
  const have = new Set(Object.keys(await import(pathToFileURL(entry).href)))
  const names = [...wanted].filter((n) => have.has(n)).sort()
  return `export { ${names.join(', ')} } from ${JSON.stringify(entry)}\n`
}

/**
 * Compiles the project's requests and flows, the runner and everything they import into one `.mjs` file that runs with
 * nothing but node: `node specbook-tests.mjs --env prod --safe --tag monitor`. The operations come from the generated
 * metadata, the examples are embedded, secrets are never included (they come from the environment of the run).
 */
export async function bundleCommand(
  project: Project,
  loader: Loader,
  o: BundleOptions,
): Promise<number> {
  const root = project.root
  const out = resolve(o.out)
  const outDir = resolve(root, project.config.codegen?.outDir ?? '.generated')
  const prefix = (project.config.codegen?.importPrefix ?? '#api').replace(/\/+$/, '')

  const unknown = await unknownOperationsMessage(project, outDir)
  if (unknown) {
    console.error(unknown)
    return 2
  }
  const { targets } = await discoverTargets(project, loader, [
    `${requestsDirFor(root)}/**/*.req.ts`,
    'sequences/**/*.seq.ts',
  ])
  const chosen = o.tags.length
    ? targets.filter((t) => t.tags.some((x) => o.tags.includes(x)))
    : targets
  if (chosen.length === 0) {
    console.error(
      o.tags.length
        ? `No request or flow has the tag ${o.tags.join(' or ')}.`
        : 'No requests or flows to bundle.',
    )
    return 3
  }
  const files = [...new Set(chosen.map((t) => t.file))].sort()

  const ops = await usedMetadata(project, outDir)

  const sourceText = (
    await Promise.all(
      [project.configFile, ...files.map((f) => join(root, f))].map((f) =>
        readFile(f, 'utf8').catch(() => ''),
      ),
    )
  ).join('\n')
  const embedded = await embed(project, outDir, ops.services)
  const environments: Record<string, Record<string, string>> = {}
  for (const env of await listEnvironmentFiles(root))
    environments[env] = (await readEnvironment(root, env)).vars

  const created = new Date().toISOString()
  const data = {
    specbook: cliVersion(),
    createdAt: created,
    git: git(root),
    environments,
    examples: embedded.examples,
    files: embedded.files,
  }
  // one copy of core, ours, whatever version the project installed: the runner and the requests must agree
  const ours = createRequire(import.meta.url)
  const warnings: string[] = []

  /** Compiles everything into `out`; `faker` is the module to embed, or undefined for a bundle that never uses faker. */
  const compile = async (faker: string | undefined) => {
    const entry = [
      `import { main } from ${JSON.stringify(standalonePath())}`,
      `import config from ${JSON.stringify(project.configFile)}`,
      ...files.map((f, i) => `import * as m${i} from ${JSON.stringify(join(root, f))}`),
      ...(faker ? [`import * as fakerModule from ${JSON.stringify(FAKER)}`] : []),
      `const data = { ...${JSON.stringify(data)}, config,`,
      `  modules: [${files.map((f, i) => `{ file: ${JSON.stringify(f)}, mod: m${i} }`).join(', ')}],`,
      `  faker: ${faker ? 'fakerModule' : 'undefined'} }`,
      'main(data).then((code) => process.exit(code), (e) => {',
      '  console.error(e instanceof Error ? e.message : e)',
      '  process.exit(2)',
      '})',
    ].join('\n')

    const plugin: Plugin = {
      name: 'specbook-bundle',
      resolveId(id) {
        if (id === ENTRY) return ENTRY
        if (id === FAKER) return FAKER
        if (id.startsWith(`${prefix}/`) && !id.slice(prefix.length + 1).includes('/'))
          return `\0specbook:api:${id.slice(prefix.length + 1)}`
        if (id === '@specbook/core' || id.startsWith('@specbook/core/')) return ours.resolve(id)
        return undefined
      },
      load(id) {
        if (id === ENTRY) return entry
        if (id === FAKER) return faker
        if (!id.startsWith('\0specbook:api:')) return undefined
        const service = id.slice('\0specbook:api:'.length)
        const metas = ops.services[service]
        if (!metas) throw new Error(`Service "${service}" has no operations your requests use`)
        return [
          "import { defineOperation } from '@specbook/core'",
          ...Object.entries(metas).map(
            ([opId, meta]) =>
              `export const ${opId} = /* @__PURE__ */ defineOperation(${JSON.stringify(meta)})`,
          ),
          '',
        ].join('\n')
      },
    }

    const build = await rolldown({
      input: ENTRY,
      platform: 'node',
      external: o.external ?? [],
      plugins: [plugin],
      cwd: root,
      onLog: (level, log) => {
        if (level === 'warn')
          warnings.push(`${log.message}${log.id ? ` (${relative(root, log.id)})` : ''}`)
      },
    })
    await mkdir(dirname(out), { recursive: true })
    const written = await build.write({
      file: out,
      format: 'esm',
      minify: true,
      codeSplitting: false,
      banner: '#!/usr/bin/env node',
    })
    await build.close()
    // a helper the requests import can use faker without the text of a request saying so: the module graph tells
    return written.output.some(
      (c) =>
        c.type === 'chunk' && Object.keys(c.modules).some((m) => m.endsWith('/core/src/faker.ts')),
    )
  }

  const noFaker = () =>
    console.error(
      'These tests use faker, but @faker-js/faker is not installed in this project. Add it to devDependencies (npm install --save-dev @faker-js/faker).',
    )
  try {
    // faker goes in when the tests' own text, examples or environments use it, or (found while compiling) a module they import does
    const text = `${sourceText}\n${JSON.stringify(embedded.examples)}\n${JSON.stringify(environments)}`
    let faker = USES_FAKER.test(text) ? await fakerSource(project) : undefined
    if (USES_FAKER.test(text) && !faker) {
      noFaker()
      return 2
    }
    const importsFaker = await compile(faker)
    if (importsFaker && !faker) {
      faker = await fakerSource(project)
      if (!faker) {
        noFaker()
        return 2
      }
      await compile(faker)
    }
  } catch (e) {
    console.error(
      `Could not compile the tests into one file:\n${e instanceof Error ? e.message : e}`,
    )
    console.error(
      'A package that cannot be compiled in (a native addon, a computed require) can stay an import: --external <package>. A browser cannot load it, so replace it with fetch or plain code if the request must also run in the portal.',
    )
    return 2
  }
  await chmod(out, 0o755)
  const bytes = await readFile(out)
  const hash = sha256(bytes)
  await writeFile(`${out}.sha256`, `${hash}  ${basename(out)}\n`)

  for (const w of [...new Set(warnings)]) console.error(`⚠ ${w}`)
  if (embedded.bytes > 1_000_000)
    console.error(
      `⚠ ${(embedded.bytes / 1e6).toFixed(1)} MB of files that requests upload are inside the bundle`,
    )
  if (o.external?.length)
    console.log(`  left as imports, to be installed where it runs: ${o.external.join(', ')}`)
  console.log(
    `✓ bundle: ${chosen.length} ${chosen.length === 1 ? 'test' : 'tests'}, ${(statSync(out).size / 1024).toFixed(0)} KB → ${relative(process.cwd(), out) || out}`,
  )
  console.log(`  sha256 ${hash}`)
  return 0
}
