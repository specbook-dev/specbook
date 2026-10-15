import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { type GenerateOptions, generate } from './generate'

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])),
  )
  return nested.flat()
}

let counter = 0

/**
 * Writes `content` to `full` so a reader never sees half a file: into a sibling temp file, then renamed
 * over the target (atomic on one file system). A file that already holds this content is left alone,
 * which keeps its timestamp and spares a watching dev server a reload for nothing.
 */
async function writeAtomically(full: string, content: string): Promise<void> {
  const current = await readFile(full, 'utf8').catch(() => undefined)
  if (current === content) return
  const tmp = `${full}.${process.pid}.${counter++}.tmp`
  try {
    await writeFile(tmp, content)
    await rename(tmp, full)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

export async function generateToDisk(opts: GenerateOptions & { outDir: string }) {
  const out = await generate(opts)
  const root = join(opts.outDir, opts.service)
  const keep = new Set(out.files.map((f) => f.path))
  for (const f of out.files) {
    const full = join(root, f.path)
    await mkdir(dirname(full), { recursive: true })
    await writeAtomically(full, f.content)
  }
  // drop files an earlier generation left behind (renamed or removed operations and examples),
  // after the new ones are in place so nothing a running loader needs is ever missing
  for (const file of await filesUnder(root)) {
    // another generation's file in flight is not ours to remove
    if (file.endsWith('.tmp')) continue
    if (!keep.has(relative(root, file).split(sep).join('/'))) await rm(file, { force: true })
  }
  return { root, ...out }
}
