// The operations a project's requests and flows use, found by reading their imports: what a minimal portal publishes
// and what a bundle compiles in.

import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { OpMeta } from '@specbook/core/internal'
import fg from 'fast-glob'
import { parseSync } from 'vite'
import type { Project } from './project'

const prefixOf = (project: Pick<Project, 'config'>) =>
  (project.config.codegen?.importPrefix ?? '#api').replace(/\/+$/, '')

/** What a source file imports from `<prefix>/<service>`: the named operations, or `all` for a namespace import. */
export interface ServiceImport {
  service: string
  names: string[]
  all: boolean
}

const IMPORT_RE =
  /import\s+(type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\*\s+as\s+[\w$]+|\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g

/** Imports from the generated services in one file; `import type` is ignored, as it is erased and needs nothing at run time. */
export function importedOperations(file: string, text: string, prefix = '#api'): ServiceImport[] {
  const found = new Map<string, ServiceImport>()
  const add = (service: string, names: string[], all: boolean) => {
    const cur = found.get(service) ?? { service, names: [], all: false }
    cur.names.push(...names)
    cur.all ||= all
    found.set(service, cur)
  }
  const serviceOf = (spec: string) => {
    if (!spec.startsWith(`${prefix}/`)) return undefined
    const rest = spec.slice(prefix.length + 1)
    return rest && !rest.includes('/') ? rest : undefined
  }
  try {
    const parsed = parseSync(file, text, { lang: 'ts' })
    for (const imp of parsed.module.staticImports) {
      const service = serviceOf(imp.moduleRequest.value)
      if (!service) continue
      for (const e of imp.entries) {
        if (e.isType) continue
        if (e.importName.kind === 'NamespaceObject') add(service, [], true)
        else if (e.importName.kind === 'Name' && e.importName.name)
          add(service, [e.importName.name], false)
      }
    }
    return [...found.values()]
  } catch {
    /* an unparsable file falls back to a text scan */
  }
  for (const m of text.matchAll(IMPORT_RE)) {
    const [, isType, , braces, spec] = m
    const service = spec ? serviceOf(spec) : undefined
    if (!service || isType) continue
    if (braces === undefined) add(service, [], /\*\s+as/.test(m[0]))
    else
      add(
        service,
        braces
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x && !x.startsWith('type '))
          .map((x) => x.split(/\s+as\s+/)[0] as string),
        false,
      )
  }
  return [...found.values()]
}

export interface UsedOperations {
  /** service → ids of the operations imported by name */
  named: Map<string, Set<string>>
  /** services imported as a namespace: every operation counts */
  whole: Set<string>
  /** where each operation is imported, for messages */
  where: Map<string, string[]>
}

/** Every `.ts` file of the project that can import an operation (the config's auth logins included). */
async function projectSources(root: string): Promise<string[]> {
  return fg(['**/*.ts', '.specbook/**/*.ts'], {
    cwd: root,
    absolute: true,
    dot: true,
    ignore: [
      '**/node_modules/**',
      '**/.generated/**',
      '**/dist/**',
      '**/dist-*/**',
      '**/.git/**',
      '**/*.d.ts',
    ],
  })
}

export async function usedOperations(
  project: Pick<Project, 'root' | 'config'>,
): Promise<UsedOperations> {
  const out: UsedOperations = { named: new Map(), whole: new Set(), where: new Map() }
  const prefix = prefixOf(project)
  for (const file of (await projectSources(project.root)).sort()) {
    const text = await readFile(file, 'utf8').catch(() => '')
    if (!text.includes(prefix)) continue
    const rel = relative(project.root, file).split(sep).join('/')
    for (const imp of importedOperations(file, text, prefix)) {
      if (imp.all) out.whole.add(imp.service)
      const set = out.named.get(imp.service) ?? new Set<string>()
      for (const n of imp.names) {
        set.add(n)
        const key = `${imp.service}/${n}`
        out.where.set(key, [...(out.where.get(key) ?? []), rel])
      }
      out.named.set(imp.service, set)
    }
  }
  return out
}

/** `service/Operation` for every operation the project uses, a namespace import counting for the whole service. */
export async function usedOperationKeys(
  project: Pick<Project, 'root' | 'config'>,
  outDir: string,
): Promise<Set<string>> {
  const used = await usedOperations(project)
  const keys = new Set<string>()
  for (const [service, names] of used.named)
    if (project.config.services[service]) for (const n of names) keys.add(`${service}/${n}`)
  for (const service of used.whole)
    for (const id of Object.keys(
      (await readJson<Record<string, OpMeta>>(metaFile(outDir, service))) ?? {},
    ))
      keys.add(`${service}/${id}`)
  // a name that is no operation (a typo, a removed one) is not published
  const known = new Set<string>()
  for (const service of new Set([...keys].map((k) => k.slice(0, k.indexOf('/'))))) {
    for (const id of Object.keys(
      (await readJson<Record<string, OpMeta>>(metaFile(outDir, service))) ?? {},
    ))
      known.add(`${service}/${id}`)
  }
  return new Set([...keys].filter((k) => known.has(k)))
}

const metaFile = (outDir: string, service: string) => join(outDir, service, 'opmeta.json')

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** The operations' metadata that generation recorded for a service, when the generated folder has it. */
export const readGenerated = (outDir: string, service: string) =>
  readJson<Record<string, OpMeta>>(metaFile(outDir, service))

/** What a bundle compiles in: the metadata of each operation the project uses, service by service. */
export async function usedMetadata(
  project: Pick<Project, 'root' | 'config'>,
  outDir: string,
): Promise<{ services: Record<string, Record<string, OpMeta>>; missing: string[] }> {
  const keys = [...(await usedOperationKeys(project, outDir))].sort()
  const services: Record<string, Record<string, OpMeta>> = {}
  for (const key of keys) {
    const [service, id] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)]
    const metas = await readGenerated(outDir, service)
    const meta = metas?.[id]
    if (meta) {
      services[service] ??= {}
      services[service][id] = meta
    }
  }
  // an import of a name that is no operation (a typo, one the spec dropped) cannot run
  const used = await usedOperations(project)
  const missing: string[] = []
  for (const [service, names] of used.named) {
    if (!project.config.services[service]) continue
    // without generated metadata there is nothing to compare with: generation is what reports that
    if (!(await readGenerated(outDir, service))) continue
    for (const id of [...names].sort())
      if (!services[service]?.[id]) missing.push(`${id} (${service})`)
  }
  return { services, missing }
}

/** A message for imports that are no operation of the spec, which would otherwise surface as an error from deep in a load. */
export async function unknownOperationsMessage(
  project: Pick<Project, 'root' | 'config'>,
  outDir: string,
): Promise<string | undefined> {
  const { missing } = await usedMetadata(project, outDir)
  return missing.length
    ? `Not operations of the spec: ${missing.join(', ')}. Check the imports, or run "specbook generate".`
    : undefined
}
