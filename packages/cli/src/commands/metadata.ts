import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomically } from '@specbook/codegen'
import { scanProject } from '@specbook/vite'
import fg from 'fast-glob'
import type { Loader } from '../load'

const isSequence = (v: any) => v?.kind === 'sequence'

/**
 * `specbook.json`: titles and summaries of every service operation and sequence, so a host page or the
 * docs sidebar can list them without loading service code or every `.seq.ts`.
 */
export async function writeMetadata(root: string, outDir: string, loader: Loader): Promise<void> {
  const services: Record<string, unknown> = {}
  for (const file of await fg('*/manifest.json', { cwd: outDir, absolute: true })) {
    const m = JSON.parse(await readFile(file, 'utf8'))
    services[m.service] = {
      title: m.title,
      operations: Object.fromEntries(
        m.operations.map((o: any) => [
          o.id,
          {
            title: o.summary?.replace(/\.$/, '') ?? o.id,
            summary: o.summary,
            method: o.method,
            path: o.path,
            tags: o.tags,
            examples: o.examples,
          },
        ]),
      ),
    }
  }
  const sequences: Record<string, unknown> = {}
  for (const file of (await scanProject(root)).sequences) {
    try {
      const mod = await loader.import<Record<string, any>>(join(root, file))
      const seq = [mod.default, ...Object.values(mod)].find(isSequence)
      if (seq) {
        const { id, title, description, tags, group } = seq.meta
        sequences[id] = { title, description, tags, group, file }
      }
    } catch {
      /* a broken sequence must not break generate; it shows up when opened */
    }
  }
  // atomically: the file is large (over 512 KiB on a big project, which Node writes in pieces), and another
  // process generating into the same folder, or a dev server, must never read half of it
  await writeAtomically(
    join(outDir, 'specbook.json'),
    `${JSON.stringify({ services, sequences }, null, 2)}\n`,
  )
}
