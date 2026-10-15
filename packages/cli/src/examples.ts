import { File } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Example, ExampleLoader, FileReader } from '@specbook/core'
import fg from 'fast-glob'
import type { Project } from './project'

const IGNORE = ['**/node_modules/**', '**/.generated/**', '**/dist/**', '**/.git/**']

/**
 * Request examples for `RequestInput.example`: `<service>/<OperationId>/<name>.example.json` in the
 * project wins over the generated one of the same name. `dir` is the absolute folder uploads resolve from.
 */
export function exampleLoadersFor(project: Project): {
  example: ExampleLoader
  readFile: FileReader
} {
  const outDir = resolve(project.root, project.config.codegen?.outDir ?? '.generated')
  const example: ExampleLoader = async (op, name) => {
    const rel = `${op.service}/${op.id}/${name}.example.json`
    const [custom] = await fg(`**/${rel}`, { cwd: project.root, absolute: true, ignore: IGNORE })
    const file = custom ?? join(outDir, op.service, 'examples', op.id, `${name}.example.json`)
    try {
      const doc = JSON.parse(await readFile(file, 'utf8')) as Example
      return { ...doc, source: custom ? 'project' : 'generated', dir: dirname(file) }
    } catch {
      return undefined
    }
  }
  const read: FileReader = async (path, dir) => {
    const abs = resolve(dir ?? project.root, path)
    return new File([await readFile(abs)], basename(abs)) as unknown as globalThis.File
  }
  return { example, readFile: read }
}
