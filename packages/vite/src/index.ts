import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { environmentNames } from '@specbook/core'
import fg from 'fast-glob'
import type { Plugin, ViteDevServer } from 'vite'
import { type AddressConfig, addressesFor, NO_ADDRESSES } from './addresses'
import { definitionRefs, pruneDefinitions } from './definitions'
import { createDiscovery } from './discovery'
import { scanDocs } from './docs'
import {
  ensureEnvironmentsDir,
  isEnvName,
  isVarName,
  listEnvironmentFiles,
  readAllVars,
  readEnvironment,
  secretsFileFor,
  sharedSecretsFile,
  varsFile,
  writeEnvKey,
} from './environments'
import { scanExamples } from './examples'
import { requestsDirFor, safeProjectPath, scanProject } from './files'
import { type EnvironmentAddresses, handleProxy, type ProxyConfig } from './proxy'
import { scanRequests } from './requests'
import { parseSequenceMeta, scanSequences } from './sequences'

export * from './environments'
export { requestsDirFor, safeProjectPath, scanProject } from './files'
export type { EnvironmentAddresses, ProxyConfig, ProxyDeps } from './proxy'
export { handleProxy } from './proxy'

export interface SpecbookPluginOptions {
  /** Absolute path of the user's project (where .specbook/ lives). */
  projectRoot: string
  /** Generated code directory relative to the project root. Default `.generated`. */
  outDir?: string
  /**
   * Publish only these operations (`service/OperationId`): the ones a project's requests and flows use. The catalog,
   * schemas, examples, docs and definitions of every other operation are left out, so the build neither carries nor
   * reveals the rest of the API.
   */
  operations?: Set<string>
}

const VIRTUAL = 'virtual:specbook/registry'
const RESOLVED = `\0${VIRTUAL}`
const VIRTUAL_TYPES = 'virtual:specbook/types'
const RESOLVED_TYPES = `\0${VIRTUAL_TYPES}`
const VIRTUAL_FAKER = 'virtual:specbook/faker'
const RESOLVED_FAKER = `\0${VIRTUAL_FAKER}`
const VIRTUAL_FAKER_LOCALE = 'virtual:specbook/faker-locale/'
const RESOLVED_FAKER_LOCALE = `\0${VIRTUAL_FAKER_LOCALE}`
const VIRTUAL_MANIFESTS = 'virtual:specbook/manifests'
const RESOLVED_MANIFESTS = `\0${VIRTUAL_MANIFESTS}`
const VIRTUAL_MANIFEST = 'virtual:specbook/manifest/'
const RESOLVED_MANIFEST = `\0${VIRTUAL_MANIFEST}`
const VIRTUAL_OPERATIONS = 'virtual:specbook/operations'
const RESOLVED_OPERATIONS = `\0${VIRTUAL_OPERATIONS}`
const VIRTUAL_DOC = 'virtual:specbook/doc/'
const RESOLVED_DOC = `\0${VIRTUAL_DOC}`

function findConfig(root: string): string | undefined {
  return [join(root, '.specbook/specbook.config.ts'), join(root, 'specbook.config.ts')].find(
    existsSync,
  )
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let d = ''
    req.on('data', (c) => {
      d += c
    })
    req.on('end', () => ok(d))
    req.on('error', fail)
  })
}

/** Locale names a faker install ships (`de`, `en_US`, ...), from its `locale/` folder next to the entry. */
function fakerLocales(entry: string): string[] {
  const names = new Set<string>(['en', 'base'])
  const dir = join(dirname(entry), 'locale')
  if (existsSync(dir))
    for (const f of readdirSync(dir)) {
      const m = /^([A-Za-z0-9_]+)\.js$/.exec(f)
      if (m) names.add(m[1] as string)
    }
  return [...names].sort()
}

/** What the sidebar and palette need; descriptions and example titles load per operation (`operationDocs`). */
function slim(manifests: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(manifests).map(([k, m]) => [
      k,
      {
        ...m,
        operations: m.operations.map(
          ({ description, examples, file, ...o }: Record<string, unknown>) => o,
        ),
      },
    ]),
  )
}

async function collectTypes(root: string, outDir: string) {
  const libs: Record<string, string> = {}
  const req = createRequire(join(root, 'package.json'))
  try {
    const entry = req.resolve('@specbook/core')
    const srcDir = dirname(entry)
    const files = await fg('**/*.ts', { cwd: srcDir, ignore: ['**/*.test.ts'] })
    for (const f of files) {
      libs[`file:///node_modules/@specbook/core/src/${f}`] = await readFile(join(srcDir, f), 'utf8')
    }
    libs['file:///node_modules/@specbook/core/package.json'] = JSON.stringify({
      name: '@specbook/core',
      types: './src/index.ts',
    })
  } catch {
    /* core not resolvable from the project: editor falls back to untyped */
  }
  const genDir = join(root, outDir)
  for (const f of await fg('**/*.ts', { cwd: genDir })) {
    libs[`file:///${outDir}/${f}`] = await readFile(join(genDir, f), 'utf8')
  }
  const project = await scanProject(root)
  const sources: Record<string, string> = {}
  for (const f of project.sources.filter((s) => s.endsWith('.ts'))) {
    sources[f] = await readFile(join(root, f), 'utf8')
  }
  return { libs, sources }
}

export function specbook(options: SpecbookPluginOptions): Plugin {
  const root = resolve(options.projectRoot)
  const outDir = options.outDir ?? '.generated'
  const only = options.operations
  /** Whether an operation is part of this build. */
  const keep = (service: string, op: string) => !only || only.has(`${service}/${op}`)
  /** per service, the shared definitions its kept schemas refer to (a minimal build trims the rest) */
  const neededDefs = new Map<string, Set<string>>()
  let server: ViteDevServer | undefined
  let isBuild = false
  let docHtml: string[] = []
  /** build only: parts of the registry that live in their own chunks, and the data files served as assets */
  let manifestsCode = 'export {}'
  /** build: the manifest of each service, one module each */
  let manifestCode = new Map<string, string>()
  let operationsCode = 'export const operations = {}'
  /** `service/Operation` -> the generated files that make up its data bundle */
  let bundlePlan = new Map<
    string,
    {
      schema?: string
      responses?: string
      docs?: string
      examples: Record<string, string>
      mock: Record<string, string>
    }
  >()
  /** `service` -> its shared definitions file */
  let definitionFiles = new Map<string, string>()
  /** absolute operation module -> the chunk it is grouped into */
  let operationChunks = new Map<string, string>()
  const seqHeaders = new Map<string, string>()
  let notifyRegistryChanged: () => void = () => {}
  /** Credentials entered in the UI: never written to disk, gone when the server stops. */
  const memorySecrets: Record<string, Record<string, string>> = {}
  // where each OpenID Connect profile's token endpoint is, read once from its discovery document
  const tokenOriginOf = createDiscovery({ warn: (m) => server?.config.logger.warn(m) })

  async function registryCode(): Promise<string> {
    const files = await scanProject(root)
    const manifests: Record<string, unknown> = {}
    for (const m of await fg('*/manifest.json', { cwd: join(root, outDir), absolute: true })) {
      const parsed = JSON.parse(await readFile(m, 'utf8'))
      manifests[parsed.service] = parsed
    }
    if (only) {
      for (const [svc, m] of Object.entries(manifests)) {
        const mm = m as { operations: { id: string; tags?: string[] }[]; tags?: string[] }
        mm.operations = mm.operations.filter((o) => keep(svc, o.id))
        if (mm.operations.length === 0) delete manifests[svc]
        else mm.tags = [...new Set(mm.operations.flatMap((o) => o.tags ?? []))]
      }
    }
    const inScope = (svc: string, op: string) => svc in manifests && keep(svc, op)
    // response examples: <svc>/examples/<Op>/<status|default>.response.json, keyed `svc/Op.<status|default>`
    const examples = (
      await fg('*/examples/*/*.response.json', {
        cwd: join(root, outDir),
        absolute: true,
      })
    ).filter((abs) => {
      const rel = relative(join(root, outDir), abs).split(sep)
      return inScope(rel[0] as string, rel[2] as string)
    })
    // dev: cache-busted /@fs imports (files on disk are the source of truth); build: statically analysable
    const imp = (abs: string) => {
      if (isBuild) return `() => import(${JSON.stringify(abs)})`
      // JSON is only turned into a module for a bare `?import` (extra params such as `?t=` disable
      // the transform). Generated JSON changes trigger a full reload, so no cache-busting is needed.
      if (abs.endsWith('.json'))
        return `() => import(/* @vite-ignore */ ${JSON.stringify(`/@fs${abs}`)})`
      return `(v) => import(/* @vite-ignore */ ${JSON.stringify(`/@fs${abs}`)} + '?t=' + v)`
    }
    const raw = (abs: string) =>
      `() => import(${JSON.stringify(`${abs}?raw`)}).then((m) => m.default)`
    const entry = (file: string) =>
      `{ file: ${JSON.stringify(file)}, load: ${imp(join(root, file))}${isBuild ? `, source: ${raw(join(root, file))}` : ''} }`
    const cfg = findConfig(root)
    const requestsDir = requestsDirFor(root)
    existsSync(join(root, 'apis')) && !existsSync(join(root, 'requests')) ? 'apis' : 'requests'
    let fakerEntry: string | undefined
    try {
      fakerEntry = createRequire(join(root, 'package.json')).resolve('@faker-js/faker')
    } catch {
      /* optional peer dependency */
    }
    const operationEntries = Object.values(manifests).flatMap((m) => {
      const mm = m as { service: string; operations: { id: string }[] }
      return mm.operations.map(
        (o) =>
          `  ${JSON.stringify(`${mm.service}/${o.id}`)}: ${imp(join(root, outDir, mm.service, 'operations', `${o.id}.ts`))}`,
      )
    })
    const opOf = (abs: string, suffix: RegExp) => {
      const rel = relative(join(root, outDir), abs).split(sep)
      return [rel[0] as string, (rel[2] as string).replace(suffix, '')] as const
    }
    const schemaFiles = (
      await fg('*/schemas/*.request.schema.json', { cwd: join(root, outDir), absolute: true })
    ).filter((abs) => inScope(...opOf(abs, /\.request\.schema\.json$/)))
    const responseFiles = (
      await fg('*/schemas/*.responses.schema.json', { cwd: join(root, outDir), absolute: true })
    ).filter((abs) => inScope(...opOf(abs, /\.responses\.schema\.json$/)))
    const responseEntries = responseFiles.map((abs) => {
      const rel = relative(join(root, outDir), abs).split(sep)
      const op = (rel[2] as string).replace(/\.responses\.schema\.json$/, '')
      return `  ${JSON.stringify(`${rel[0]}/${op}`)}: ${imp(abs)}`
    })
    const defFiles = (
      await fg('*/schemas/definitions.schema.json', { cwd: join(root, outDir), absolute: true })
    ).filter((abs) => (relative(join(root, outDir), abs).split(sep)[0] as string) in manifests)
    const schemaEntries = schemaFiles.map((abs) => {
      const rel = relative(join(root, outDir), abs).split(sep)
      const op = (rel[2] as string).replace(/\.request\.schema\.json$/, '')
      return `  ${JSON.stringify(`${rel[0]}/${op}`)}: ${imp(abs)}`
    })
    const docFiles = (
      await fg('*/docs/*.json', { cwd: join(root, outDir), absolute: true })
    ).filter((abs) => inScope(...opOf(abs, /\.json$/)))
    const operationDocEntries = docFiles.map((abs) => {
      const rel = relative(join(root, outDir), abs).split(sep)
      return `  ${JSON.stringify(`${rel[0]}/${(rel[2] as string).replace(/\.json$/, '')}`)}: ${imp(abs)}`
    })
    const defEntries = defFiles.map((abs) => {
      const service = relative(join(root, outDir), abs).split(sep)[0]
      return `  ${JSON.stringify(service)}: ${imp(abs)}`
    })
    const known = new Set(
      Object.values(manifests).flatMap((m) => {
        const mm = m as { service: string; operations: { id: string }[] }
        return mm.operations.map((o) => `${mm.service}/${o.id}`)
      }),
    )
    // Sequence titles come from each file's literal header, so listing them imports no sequence.
    const sequenceScan = await scanSequences(root, files.sequences)
    // which operation each request file is for, read from its text, so an embed imports only the one it opens
    const requestScan = await scanRequests(root, files.requests, new Set(Object.keys(manifests)))
    for (const f of files.sequences) {
      const src = await readFile(join(root, f), 'utf8').catch(() => '')
      seqHeaders.set(join(root, f), JSON.stringify(parseSequenceMeta(src)))
    }
    const scanned = await scanExamples(root, outDir, known)
    const keepExampleKey = (key: string) => !only || only.has(key)
    for (const key of Object.keys(scanned.examples))
      if (!keepExampleKey(key)) delete scanned.examples[key]
    const url = (abs: string) =>
      isBuild
        ? `() => import(${JSON.stringify(`${abs}?url`)}).then((m) => m.default)`
        : `() => import(/* @vite-ignore */ ${JSON.stringify(`/@fs${abs}?url`)}).then((m) => m.default)`
    const requestExampleEntries = Object.entries(scanned.examples).map(
      ([key, list]) =>
        `  ${JSON.stringify(key)}: [${list
          .map(
            (e) =>
              `{ name: ${JSON.stringify(e.name)}, source: ${JSON.stringify(e.source)}, dir: ${JSON.stringify(e.dir)}, load: ${imp(e.abs)} }`,
          )
          .join(', ')}]`,
    )
    const brandingFiles = await fg(
      '.specbook/branding/{logo,favicon}.{svg,png,jpg,jpeg,webp,ico}',
      {
        cwd: root,
        absolute: true,
        dot: true,
      },
    )
    const brandingEntries = brandingFiles.map((abs) => {
      const name = abs.slice(abs.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
      return `  ${JSON.stringify(name)}: ${url(abs)}`
    })
    const assetEntries = Object.entries(scanned.assets).map(
      ([key, abs]) => `  ${JSON.stringify(key)}: ${url(abs)}`,
    )
    // a minimal build keeps the notes on its requests and flows, and drops the pages of operations it does not publish
    const pages = (await scanDocs(root)).filter(
      (p) => !only || !p.operation || only.has(p.operation),
    )
    docHtml = pages.map((p) => p.html)
    const docEntries = pages.map(
      (p, i) =>
        `{ file: ${JSON.stringify(p.file)}, operation: ${JSON.stringify(p.operation)}, sequence: ${JSON.stringify(p.sequence)}, sequenceFile: ${JSON.stringify(p.sequenceFile)}, requestFile: ${JSON.stringify(p.requestFile)}, replace: ${JSON.stringify(p.replace)}, title: ${JSON.stringify(p.title)}, load: () => import(${JSON.stringify(`${VIRTUAL_DOC}${i}`)}).then((m) => m.default) }`,
    )
    const exampleEntries = examples.map((abs) => {
      const rel = relative(join(root, outDir), abs).split(sep)
      const status = (rel[3] as string).replace(/\.response\.json$/, '')
      const key = `${rel[0]}/${rel[2]}.${status}`
      return `  ${JSON.stringify(key)}: ${imp(abs)}`
    })
    if (isBuild) {
      // The registry stays small: manifests and the operation modules sit in their own chunks, and the
      // generated JSON (schemas, examples, docs, definitions) is served as plain files under data/.
      // one chunk per service, so a page that opens one operation fetches one service's list
      const slimmed = slim(manifests)
      manifestCode = new Map(
        Object.entries(slimmed).map(([svc, m]) => [svc, `export default ${JSON.stringify(m)}`]),
      )
      // the whole app fills `manifests` from all of them before it starts; an embed asks for the ones it needs
      manifestsCode = `import { manifests } from 'virtual:specbook/registry'
${Object.keys(slimmed)
  .map((svc, i) => `import m${i} from ${JSON.stringify(`${VIRTUAL_MANIFEST}${svc}`)}`)
  .join('\n')}
Object.assign(manifests, { ${Object.keys(slimmed)
        .map((svc, i) => `${JSON.stringify(svc)}: m${i}`)
        .join(', ')} })`
      operationsCode = `export const operations = {\n${operationEntries.join(',\n')}\n}`
      const gen = join(root, outDir)
      bundlePlan = new Map()
      const slot = (key: string) => {
        const have = bundlePlan.get(key)
        if (have) return have
        const fresh: NonNullable<ReturnType<typeof bundlePlan.get>> = { examples: {}, mock: {} }
        bundlePlan.set(key, fresh)
        return fresh
      }
      for (const abs of schemaFiles) {
        const rel = relative(gen, abs).split(sep)
        slot(`${rel[0]}/${(rel[2] as string).replace(/\.request\.schema\.json$/, '')}`).schema = abs
      }
      for (const abs of responseFiles) {
        const rel = relative(gen, abs).split(sep)
        slot(
          `${rel[0]}/${(rel[2] as string).replace(/\.responses\.schema\.json$/, '')}`,
        ).responses = abs
      }
      for (const abs of docFiles) {
        const rel = relative(gen, abs).split(sep)
        slot(`${rel[0]}/${(rel[2] as string).replace(/\.json$/, '')}`).docs = abs
      }
      for (const abs of examples) {
        const rel = relative(gen, abs).split(sep)
        slot(`${rel[0]}/${rel[2]}`).mock[(rel[3] as string).replace(/\.response\.json$/, '')] = abs
      }
      for (const [key, list] of Object.entries(scanned.examples))
        for (const e of list) if (e.source === 'generated') slot(key).examples[e.name] = e.abs
      definitionFiles = new Map(
        defFiles.map((abs) => [relative(gen, abs).split(sep)[0] as string, abs]),
      )
      // operation modules grouped by tag, so a service is a few dozen chunks rather than a thousand
      operationChunks = new Map()
      for (const m of Object.values(manifests) as {
        service: string
        operations: { id: string; tags: string[] }[]
      }[]) {
        const counts = new Map<string, number>()
        for (const o of m.operations) {
          const tag = (o.tags[0] ?? 'default').replace(/[^A-Za-z0-9_-]+/g, '-')
          const n = counts.get(tag) ?? 0
          counts.set(tag, n + 1)
          operationChunks.set(
            join(gen, m.service, 'operations', `${o.id}.ts`),
            `ops-${m.service}-${tag}-${Math.floor(n / 40)}`,
          )
        }
      }
      const index: Record<string, [string, 'p' | 'g'][]> = {}
      const projectLoads: string[] = []
      for (const [key, list] of Object.entries(scanned.examples)) {
        index[key] = list.map((e) => [e.name, e.source === 'project' ? 'p' : 'g'])
        for (const e of list)
          if (e.source === 'project')
            projectLoads.push(`  ${JSON.stringify(`${key}/${e.name}`)}: ${imp(e.abs)}`)
      }
      const services = Object.keys(manifests)
      return `export const mode = "static"
export const minimal = ${JSON.stringify(!!only)}
export const project = ${JSON.stringify({ root, outDir, requestsDir })}
// where the data files are: dist/data, whether this chunk is in dist/ or dist/assets/
const dataBase = import.meta.url.replace(/(assets\\/)?[^/]*$/, '') + 'data/'
const fetchJson = (rel) =>
  fetch(dataBase + rel).then((r) => (r.ok ? r.json() : undefined), () => undefined)
// one file per operation holds its schemas, docs, examples and mock responses
const bundles = new Map()
const bundle = (key) => {
  if (!bundles.has(key)) bundles.set(key, fetchJson(key + '.json').then((b) => b ?? {}))
  return bundles.get(key)
}
const part = (pick) =>
  new Proxy({}, { get: (_, key) => (typeof key === 'string' && key.includes('/') ? () => bundle(key).then((b) => ({ default: pick(b) })) : undefined) })
export const manifests = {}
const manifestLoaders = {${services.map((svc) => `\n  ${JSON.stringify(svc)}: () => import(${JSON.stringify(`${VIRTUAL_MANIFEST}${svc}`)})`).join(',')}\n}
export const loadManifests = (names = Object.keys(manifestLoaders)) =>
  Promise.all(names.map((svc) => manifests[svc] ? undefined : manifestLoaders[svc]?.().then((m) => { manifests[svc] = m.default }))).then(() => undefined)
export const requests = [${files.requests.map(entry).join(',\n')}]
export const requestMeta = ${JSON.stringify(requestScan.meta)}
export const unresolvedRequests = ${JSON.stringify(requestScan.unresolved)}
export const sequences = [${files.sequences.map(entry).join(',\n')}]
export const sequenceMeta = ${JSON.stringify(sequenceScan.meta)}
export const unresolvedSequences = ${JSON.stringify(sequenceScan.unresolved)}
export const brandingAssets = {\n${brandingEntries.join(',\n')}\n}
export const environmentVars = ${JSON.stringify(await readAllVars(root))}
const loadOperations = () => import(${JSON.stringify(VIRTUAL_OPERATIONS)}).then((m) => m.operations)
export const operations = new Proxy({}, {
  get: (_, key) => typeof key === 'string' ? (v) => loadOperations().then((ops) => {
    if (!ops[key]) throw new Error('Unknown operation ' + key)
    return ops[key](v)
  }) : undefined,
})
export const schemas = part((b) => b.schema)
export const responseSchemas = part((b) => b.responses)
export const operationDocs = part((b) => b.docs)
export const examples = new Proxy({}, {
  get: (_, key) => {
    if (typeof key !== 'string' || !key.includes('.')) return undefined
    const at = key.lastIndexOf('.')
    return () => bundle(key.slice(0, at)).then((b) => ({ default: b.mock?.[key.slice(at + 1)] }))
  },
})
export const definitions = {${services.map((svc) => `\n  ${JSON.stringify(svc)}: () => fetchJson(${JSON.stringify(`${svc}/_definitions.json`)}).then((d) => ({ default: d }))`).join(',')}\n}
const exampleIndex = ${JSON.stringify(index)}
const projectLoad = {\n${projectLoads.join(',\n')}\n}
const exampleLists = new Map()
export const requestExamples = new Proxy({}, {
  get: (_, key) => {
    if (typeof key !== 'string' || !exampleIndex[key]) return undefined
    if (!exampleLists.has(key)) {
      exampleLists.set(key, exampleIndex[key].map(([name, src]) => ({
        name,
        source: src === 'p' ? 'project' : 'generated',
        dir: key + (src === 'p' ? '@project' : '@generated'),
        load: src === 'p' ? projectLoad[key + '/' + name] : () => bundle(key).then((b) => ({ default: b.examples?.[name] })),
      })))
    }
    return exampleLists.get(key)
  },
})
export const assets = {\n${assetEntries.join(',\n')}\n}
export const docs = [${docEntries.join(',\n')}]
export const loadFaker = ${fakerEntry ? `() => import('virtual:specbook/faker')` : 'null'}
export const loadConfig = ${cfg ? imp(cfg) : '() => Promise.resolve({ default: { project: "specbook", services: {} } })'}
`
    }
    return `export const mode = ${JSON.stringify(isBuild ? 'static' : 'dev')}
export const minimal = ${JSON.stringify(!!only)}
export const project = ${JSON.stringify({ root, outDir, requestsDir })}
export const manifests = ${JSON.stringify(slim(manifests))}
export const loadManifests = () => Promise.resolve()
export const requests = [${files.requests.map(entry).join(',\n')}]
export const requestMeta = ${JSON.stringify(requestScan.meta)}
export const unresolvedRequests = ${JSON.stringify(requestScan.unresolved)}
export const sequences = [${files.sequences.map(entry).join(',\n')}]
export const sequenceMeta = ${JSON.stringify(sequenceScan.meta)}
export const unresolvedSequences = ${JSON.stringify(sequenceScan.unresolved)}
export const brandingAssets = {\n${brandingEntries.join(',\n')}\n}
export const environmentVars = ${JSON.stringify(await readAllVars(root))}
export const operations = {\n${operationEntries.join(',\n')}\n}
export const schemas = {\n${schemaEntries.join(',\n')}\n}
export const responseSchemas = {\n${responseEntries.join(',\n')}\n}
export const operationDocs = {\n${operationDocEntries.join(',\n')}\n}
export const definitions = {\n${defEntries.join(',\n')}\n}
export const examples = {\n${exampleEntries.join(',\n')}\n}
export const requestExamples = {\n${requestExampleEntries.join(',\n')}\n}
export const assets = {\n${assetEntries.join(',\n')}\n}
export const docs = [${docEntries.join(',\n')}]
export const loadFaker = ${fakerEntry ? `() => import('virtual:specbook/faker')` : 'null'}
export const loadConfig = ${cfg ? imp(cfg) : '() => Promise.resolve({ default: { project: "specbook", services: {} } })'}
`
  }

  async function loadProjectConfig(): Promise<AddressConfig | undefined> {
    const cfgFile = findConfig(root)
    if (!server || !cfgFile) return undefined
    return ((await server.ssrLoadModule(cfgFile)).default ?? {}) as AddressConfig
  }

  async function getProxyConfig(): Promise<ProxyConfig> {
    const cfg = await loadProjectConfig()
    if (!cfg) return { secretNames: {}, resolve: async () => NO_ADDRESSES }
    // addresses are worked out here, per environment, from config and files: the page never says where to go
    const resolve = async (env: string): Promise<EnvironmentAddresses> =>
      isEnvName(env)
        ? addressesFor(
            cfg,
            env,
            {
              environments: await listEnvironmentFiles(root),
              vars: async () => (await readEnvironment(root, env)).vars,
            },
            tokenOriginOf,
          )
        : NO_ADDRESSES
    return { secretNames: cfg.secrets ?? {}, resolve }
  }

  return {
    name: 'specbook',
    configResolved(c) {
      isBuild = c.command === 'build'
    },
    async generateBundle() {
      const read = async (abs: string) => JSON.parse(await readFile(abs, 'utf8'))
      for (const [key, p] of bundlePlan) {
        const out: Record<string, unknown> = {}
        if (p.schema) out.schema = await read(p.schema)
        if (p.responses) out.responses = await read(p.responses)
        if (p.docs) {
          const docs = (await read(p.docs)) as { description?: string; examples?: unknown[] }
          // nothing worth a file or a request: no text, and no examples beyond the generated pair
          if (docs.description || (docs.examples?.length ?? 0) > 2) out.docs = docs
        }
        const names = Object.keys(p.examples)
        if (names.length) {
          out.examples = Object.fromEntries(
            await Promise.all(names.map(async (n) => [n, await read(p.examples[n] as string)])),
          )
        }
        const statuses = Object.keys(p.mock)
        if (statuses.length) {
          out.mock = Object.fromEntries(
            await Promise.all(statuses.map(async (n) => [n, await read(p.mock[n] as string)])),
          )
        }
        if (only) {
          const svc = key.slice(0, key.indexOf('/'))
          const set = neededDefs.get(svc) ?? new Set<string>()
          for (const name of definitionRefs(JSON.stringify([out.schema, out.responses])))
            set.add(name)
          neededDefs.set(svc, set)
        }
        this.emitFile({
          type: 'asset',
          fileName: `data/${key}.json`,
          source: JSON.stringify(out),
        })
      }
      for (const [svc, abs] of definitionFiles)
        this.emitFile({
          type: 'asset',
          fileName: `data/${svc}/_definitions.json`,
          source: only
            ? JSON.stringify(
                pruneDefinitions(JSON.parse(await readFile(abs, 'utf8')), neededDefs.get(svc)),
              )
            : await readFile(abs),
        })
    },
    config(_, env) {
      if (env.command !== 'build') return undefined
      return {
        build: {
          rollupOptions: {
            output: {
              // manifests are their own chunk (preloaded with the app, so no extra round trip), and
              // operation modules are grouped by tag instead of one chunk per operation
              manualChunks(id: string) {
                if (id === RESOLVED_MANIFESTS) return 'manifests'
                if (id.startsWith(RESOLVED_MANIFEST))
                  return `manifest-${id.slice(RESOLVED_MANIFEST.length)}`
                return operationChunks.get(id)
              },
            },
          },
        },
      }
    },
    resolveId(id) {
      if (id === VIRTUAL) return RESOLVED
      if (id === VIRTUAL_TYPES) return RESOLVED_TYPES
      if (id === VIRTUAL_FAKER) return RESOLVED_FAKER
      if (id === VIRTUAL_MANIFESTS) return RESOLVED_MANIFESTS
      if (id.startsWith(VIRTUAL_MANIFEST)) return `\0${id}`
      if (id === VIRTUAL_OPERATIONS) return RESOLVED_OPERATIONS
      if (id.startsWith(VIRTUAL_FAKER_LOCALE)) return `\0${id}`
      if (id.startsWith(VIRTUAL_DOC)) return `\0${id}`
      return undefined
    },
    async load(id) {
      if (id === RESOLVED) return registryCode()
      if (id === RESOLVED_MANIFESTS) return manifestsCode
      if (id.startsWith(RESOLVED_MANIFEST))
        return manifestCode.get(id.slice(RESOLVED_MANIFEST.length)) ?? 'export default {}'
      if (id === RESOLVED_OPERATIONS) return operationsCode
      if (id === RESOLVED_FAKER || id.startsWith(RESOLVED_FAKER_LOCALE)) {
        // Let Vite resolve the package from the project (ESM entry, not the CJS one `require.resolve` finds).
        const r = await this.resolve('@faker-js/faker', join(root, 'package.json'), {
          skipSelf: true,
        })
        if (!r) return 'export {}'
        const pkg = JSON.stringify(r.id)
        if (id.startsWith(RESOLVED_FAKER_LOCALE))
          return `export { ${id.slice(RESOLVED_FAKER_LOCALE.length)} as default } from ${pkg}`
        // Faker's locales are about 2 MB together, so each is its own chunk and only the ones a run
        // needs are fetched: `locales[name]()` resolves to the locale definition.
        // the package's own folder, not Vite's pre-bundled copy of it
        let entry = r.id
        try {
          entry = createRequire(join(root, 'package.json')).resolve('@faker-js/faker')
        } catch {
          /* fall back to the resolved id */
        }
        const names = fakerLocales(entry)
        return `export { Faker, base } from ${pkg}
export const locales = {
${names.map((n) => `  ${JSON.stringify(n)}: () => import(${JSON.stringify(`${VIRTUAL_FAKER_LOCALE}${n}`)}).then((m) => m.default)`).join(',\n')}
}`
      }
      if (id === RESOLVED_TYPES)
        return `export default ${JSON.stringify(await collectTypes(root, outDir))}`
      if (id.startsWith(RESOLVED_DOC))
        return `export default ${JSON.stringify(docHtml[Number(id.slice(RESOLVED_DOC.length))] ?? '')}`
      return undefined
    },
    configureServer(s) {
      server = s
      // chokidar 4 has no globs: watch the project's own folders (not dependencies or generated output)
      const SKIP = new Set([
        'node_modules',
        '.git',
        'dist',
        'dist-docs',
        '.turbo',
        'openapi',
        basename(outDir),
      ])
      for (const entry of readdirSync(root, { withFileTypes: true }))
        if (entry.isDirectory() && !SKIP.has(entry.name)) s.watcher.add(join(root, entry.name))

      const relevant = (file: string) => {
        const rel = relative(root, file)
        if (rel.startsWith('..') || /node_modules/.test(rel)) return false
        // not `.specbook/environments/*.env`: the page reads an environment's variables live, and a reload
        // when its file is first written would blank the page under whoever is editing a variable
        return /\.(req|seq)\.ts$|\.example\.json$|\.md$/.test(rel) || rel.startsWith(outDir)
      }
      // one reload per burst of changes: a save also arrives here from the watcher
      let pending: ReturnType<typeof setTimeout> | undefined
      notifyRegistryChanged = () => {
        clearTimeout(pending)
        pending = setTimeout(() => {
          const mod = s.moduleGraph.getModuleById(RESOLVED)
          if (mod) s.moduleGraph.invalidateModule(mod)
          s.ws.send({ type: 'custom', event: 'specbook:registry-changed' })
        }, 60)
      }
      const refresh = (file: string) => {
        if (relevant(file)) notifyRegistryChanged()
      }
      s.watcher.on('add', refresh)
      s.watcher.on('unlink', refresh)
      s.watcher.on('change', async (file) => {
        if (file.endsWith('.md')) return refresh(file)
        if (!file.endsWith('.seq.ts')) return
        // only the listing is affected by the header; the module itself is re-imported on open
        const header = JSON.stringify(
          parseSequenceMeta(await readFile(file, 'utf8').catch(() => '')),
        )
        if (seqHeaders.get(file) !== header) {
          seqHeaders.set(file, header)
          refresh(file)
        }
      })

      s.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (!url.pathname.startsWith('/__specbook/')) return next()
        try {
          if (url.pathname === '/__specbook/save' && req.method === 'POST') {
            const { path, content, encoding } = JSON.parse(await readBody(req)) as {
              path: string
              content: string
              encoding?: 'base64'
            }
            const abs = safeProjectPath(root, path)
            if (!abs || typeof content !== 'string')
              return json(res, 400, { error: 'path not allowed' })
            await mkdir(dirname(abs), { recursive: true })
            await writeFile(abs, encoding === 'base64' ? Buffer.from(content, 'base64') : content)
            notifyRegistryChanged()
            return json(res, 200, { ok: true })
          }
          if (url.pathname === '/__specbook/source') {
            const abs = safeProjectPath(root, url.searchParams.get('path') ?? '')
            if (!abs || !existsSync(abs)) return json(res, 404, { error: 'not found' })
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            return void res.end(await readFile(abs, 'utf8'))
          }
          if (url.pathname === '/__specbook/types')
            return json(res, 200, await collectTypes(root, outDir))
          if (url.pathname === '/__specbook/environment' && req.method === 'GET') {
            const env = url.searchParams.get('env') ?? ''
            if (!isEnvName(env)) return json(res, 400, { error: 'bad environment name' })
            const cfg = await getProxyConfig()
            const values = await readEnvironment(root, env)
            const secrets = Object.entries(cfg.secretNames).map(([name, ref]) => {
              const key = ref.env ?? name
              const source =
                memorySecrets[env]?.[name] !== undefined || memorySecrets['*']?.[name] !== undefined
                  ? 'session'
                  : process.env[key] !== undefined
                    ? 'process'
                    : values.secrets[key] !== undefined
                      ? 'environment'
                      : values.shared[key] !== undefined
                        ? 'shared'
                        : undefined
              return { name, key, source }
            })
            // a declared secret sitting in the committed file is the mistake worth catching early
            const warnings = secrets
              .filter((s) => s.key in values.vars)
              .map(
                (s) =>
                  `"${s.key}" is a secret but is in ${env}.env, which is committed. Move it to ${env}.secrets.env.`,
              )
            return json(res, 200, { env, vars: values.vars, secrets, warnings })
          }
          if (url.pathname === '/__specbook/environment' && req.method === 'POST') {
            // a new environment is a copy of another one's own variables (never its secrets)
            const origin = req.headers.origin
            if (origin && new URL(origin).host !== req.headers.host)
              return json(res, 403, { error: 'cross-origin request refused' })
            const { name, from } = JSON.parse(await readBody(req)) as {
              name?: string
              from?: string
            }
            if (!isEnvName(name) || name === 'mock' || !isEnvName(from))
              return json(res, 400, { error: 'bad environment name' })
            const conf = await loadProjectConfig()
            const known = environmentNames(
              { services: conf?.services ?? {}, environments: conf?.environments },
              await listEnvironmentFiles(root),
            )
            if (known.includes(name)) return json(res, 409, { error: `"${name}" already exists` })
            if (!known.includes(from))
              return json(res, 400, { error: `unknown environment "${from}"` })
            const own = {
              ...(
                conf?.environments as Record<string, { vars?: Record<string, unknown> }> | undefined
              )?.[from]?.vars,
              ...(await readEnvironment(root, from)).vars,
            }
            await ensureEnvironmentsDir(root)
            const file = varsFile(root, name)
            await writeFile(file, `# variables for ${name}, copied from ${from}\n`)
            for (const [k, v] of Object.entries(own)) {
              if (v === null || typeof v === 'object' || !isVarName(k)) continue
              await writeEnvKey(file, k, String(v))
            }
            return json(res, 200, { ok: true, name })
          }
          if (
            (url.pathname === '/__specbook/secret' || url.pathname === '/__specbook/var') &&
            req.method === 'POST'
          ) {
            // a page on another origin must not be able to plant credentials
            const origin = req.headers.origin
            if (origin && new URL(origin).host !== req.headers.host)
              return json(res, 403, { error: 'cross-origin request refused' })
            const body = JSON.parse(await readBody(req)) as {
              name: string
              value: string | null
              env?: string
              scope?: 'session' | 'environment' | 'shared'
            }
            const { name, env } = body
            const value = body.value === null || body.value === '' ? undefined : body.value
            if (env !== undefined && !isEnvName(env))
              return json(res, 400, { error: 'bad environment name' })

            if (url.pathname === '/__specbook/var') {
              if (!isVarName(name) || !env)
                return json(res, 400, { error: 'name and env required' })
              await ensureEnvironmentsDir(root)
              await writeEnvKey(varsFile(root, env), name, value)
              return json(res, 200, { ok: true })
            }

            const cfg = await getProxyConfig()
            const ref = cfg.secretNames[name]
            if (!ref) return json(res, 400, { error: `unknown secret "${name}"` })
            const scope = body.scope ?? 'session'
            if (scope === 'session') {
              const scopeKey = env ?? '*'
              const bucket = memorySecrets[scopeKey] ?? {}
              if (value) bucket[name] = value
              else delete bucket[name]
              memorySecrets[scopeKey] = bucket
            } else if (scope === 'environment') {
              if (!env) return json(res, 400, { error: 'env required' })
              await ensureEnvironmentsDir(root)
              await writeEnvKey(secretsFileFor(root, env), ref.env ?? name, value)
              delete memorySecrets[env]?.[name]
            } else {
              await mkdir(dirname(sharedSecretsFile(root)), { recursive: true })
              await writeEnvKey(sharedSecretsFile(root), ref.env ?? name, value)
              for (const bucket of Object.values(memorySecrets)) delete bucket[name]
            }
            return json(res, 200, { ok: true })
          }
          if (
            await handleProxy(req, res, {
              getConfig: getProxyConfig,
              readSecrets: async (env) => {
                const v = await readEnvironment(root, env)
                return { ...v.shared, ...v.secrets }
              },
              env: process.env,
              memory: memorySecrets,
            })
          )
            return
          next()
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })
    },
  }
}
