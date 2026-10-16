import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import SwaggerParser from '@apidevtools/swagger-parser'
import swagger2openapi from 'swagger2openapi'
import {
  type GeneratedFile,
  type GenerateOptions,
  generateFromDoc,
  type ManifestOperation,
  type OperationMeta,
} from './build'

export * from './build'

/** Runs `use` with a spec the parser can read: a `.gz` one is unpacked to a temporary file of the same kind. */
export async function withPlainSpec<T>(
  spec: string | object,
  use: (spec: string | object) => Promise<T>,
): Promise<T> {
  if (typeof spec !== 'string' || !spec.endsWith('.gz')) return use(spec)
  const dir = await mkdtemp(join(tmpdir(), 'specbook-spec-'))
  try {
    const file = join(dir, basename(spec).replace(/\.gz$/, ''))
    await writeFile(file, gunzipSync(await readFile(spec)))
    return await use(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function loadOpenApi3(spec: string | object): Promise<any> {
  const bundled: any = await withPlainSpec(spec, (plain) => SwaggerParser.bundle(plain as any))
  if (bundled.swagger?.startsWith('2')) {
    const res = await swagger2openapi.convertObj(bundled, { patch: true, warnOnly: true } as any)
    return res.openapi
  }
  return bundled
}

export async function generate(opts: GenerateOptions): Promise<{
  files: GeneratedFile[]
  operations: ManifestOperation[]
  /** what a request needs of each operation at run time, by operation id */
  metas: Record<string, OperationMeta>
}> {
  const { files, operations, metas } = generateFromDoc(await loadOpenApi3(opts.spec), opts)
  return { files, operations, metas }
}
