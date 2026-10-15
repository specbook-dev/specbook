import SwaggerParser from '@apidevtools/swagger-parser'
import swagger2openapi from 'swagger2openapi'
import {
  type GeneratedFile,
  type GenerateOptions,
  generateFromDoc,
  type ManifestOperation,
} from './build'

export * from './build'

async function loadOpenApi3(spec: string | object): Promise<any> {
  const bundled: any = await SwaggerParser.bundle(spec as any)
  if (bundled.swagger?.startsWith('2')) {
    const res = await swagger2openapi.convertObj(bundled, { patch: true, warnOnly: true } as any)
    return res.openapi
  }
  return bundled
}

export async function generate(opts: GenerateOptions): Promise<{
  files: GeneratedFile[]
  operations: ManifestOperation[]
}> {
  const { files, operations } = generateFromDoc(await loadOpenApi3(opts.spec), opts)
  return { files, operations }
}
