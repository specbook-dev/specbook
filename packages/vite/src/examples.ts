import { relative, sep } from 'node:path'
import fg from 'fast-glob'

export interface ExampleEntry {
  name: string
  abs: string
  source: 'generated' | 'project'
  /** Key of the folder the example lives in; file-field paths are relative to it. */
  dir: string
}

export interface ExampleScan {
  /** `service/OperationId` -> examples, project files overriding generated ones of the same name */
  examples: Record<string, ExampleEntry[]>
  /** `<dir>/<file>` -> absolute path, for the non-JSON files an example may reference */
  assets: Record<string, string>
}

const IGNORE = ['**/node_modules/**', '**/.generated/**', '**/dist/**', '**/.git/**']
const NAME = /\.example\.json$/

export async function scanExamples(
  root: string,
  outDir: string,
  operations: Set<string>,
): Promise<ExampleScan> {
  const examples: Record<string, ExampleEntry[]> = {}
  const assets: Record<string, string> = {}
  const dirs = new Map<string, string>()

  const add = (key: string, entry: ExampleEntry) => {
    examples[key] ??= []
    const list = examples[key] as ExampleEntry[]
    const at = list.findIndex((e) => e.name === entry.name)
    if (at >= 0) list[at] = entry
    else list.push(entry)
    dirs.set(entry.dir, entry.abs.slice(0, entry.abs.lastIndexOf(sep)))
  }

  const gen = `${root}/${outDir}`
  for (const abs of await fg('*/examples/*/*.example.json', { cwd: gen, absolute: true })) {
    const [svc, , id, file] = relative(gen, abs).split(sep) as [string, string, string, string]
    // only operations the build knows (a minimal build lists just those it publishes)
    if (!operations.has(`${svc}/${id}`)) continue
    add(`${svc}/${id}`, {
      name: file.replace(NAME, ''),
      abs,
      source: 'generated',
      dir: `${svc}/${id}@generated`,
    })
  }
  for (const abs of await fg('**/*.example.json', { cwd: root, absolute: true, ignore: IGNORE })) {
    const parts = relative(root, abs).split(sep)
    const file = parts.pop() as string
    const id = parts.pop()
    const svc = parts.pop()
    const key = `${svc}/${id}`
    if (!svc || !id || !operations.has(key)) continue
    add(key, {
      name: file.replace(NAME, ''),
      abs,
      source: 'project',
      dir: `${svc}/${id}@project`,
    })
  }

  for (const [dir, abs] of dirs) {
    for (const f of await fg('*', { cwd: abs, absolute: false, ignore: ['*.json'] })) {
      assets[`${dir}/${f}`] = `${abs}/${f}`
    }
  }
  for (const list of Object.values(examples))
    list.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
  return { examples, assets }
}

/** Project examples first, then the spec's, then the generated default. */
const order = (e: ExampleEntry) => (e.source === 'project' ? 0 : e.name === 'default' ? 2 : 1)
