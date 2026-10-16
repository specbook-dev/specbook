// What a run needs from a project on disk: finding the requests and flows, the mock responses, the project's faker.

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import fg from 'fast-glob'
import type { Loader } from './load'
import type { Project } from './project'
import { type Target, targetsOf } from './run-tests'

/** The requests and flows in the files matching `patterns`, in file order. */
export async function discoverTargets(
  project: Project,
  loader: Loader,
  patterns: string[],
): Promise<{ targets: Target[]; files: string[] }> {
  const files = (
    await fg(patterns, {
      cwd: project.root,
      absolute: true,
      ignore: ['**/node_modules/**', '**/.generated/**'],
    })
  ).sort()
  const targets: Target[] = []
  for (const f of files) {
    const mod = await loader.import<Record<string, unknown>>(f)
    const file = relative(project.root, f).split(sep).join('/')
    targets.push(...targetsOf(mod, file))
  }
  return { targets, files }
}

/** Mock responses come from the generated folder: a development convenience, not something a run elsewhere has. */
export function mockLoaderFor(project: Project) {
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

/** The project's faker, when it has one (a peer dependency). */
export async function loadFaker(project: Project): Promise<any> {
  try {
    const entry = createRequire(join(project.root, 'package.json')).resolve('@faker-js/faker')
    return await import(pathToFileURL(entry).href)
  } catch {
    return undefined
  }
}
