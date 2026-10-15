/**
 * The generator for a browser or a worker: no file system, no Node-only parser. Hand it the text of an
 * OpenAPI 3 or Swagger 2 document and get the same data files, manifest and operation metadata the CLI
 * writes, without the TypeScript sources. Remote `$ref`s are never fetched.
 */
/// <reference path="./js-yaml.d.ts" />
import { load as parseYaml } from 'js-yaml'
import swagger2openapi from 'swagger2openapi'
import { type GenerateFlags, type GenerateOptions, generateFromDoc } from './build'

export type {
  GeneratedFile,
  GenerateFlags,
  GenerateOptions,
  ManifestOperation,
  OperationMeta,
} from './build'
export { generateFromDoc, logoOf } from './build'

/** A document's text as an object: JSON first (fast), then YAML. */
export function parseSpecText(text: string): any {
  const t = text.replace(/^﻿/, '').trimStart()
  if (t.startsWith('{')) {
    try {
      return JSON.parse(t)
    } catch {
      /* fall through: it may be YAML flow style, or broken JSON the YAML parser reports better */
    }
  }
  const doc = parseYaml(t)
  if (doc === null || typeof doc !== 'object')
    throw new Error('The file is not an OpenAPI document')
  return doc
}

/** `$ref`s that point outside the document: listed, not fetched. */
export function externalRefs(doc: unknown): string[] {
  const out = new Set<string>()
  const walk = (v: unknown, depth: number) => {
    if (depth > 60 || v === null || typeof v !== 'object') return
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
      return
    }
    for (const [k, x] of Object.entries(v)) {
      if (k === '$ref' && typeof x === 'string' && !x.startsWith('#')) out.add(x)
      else walk(x, depth + 1)
    }
  }
  walk(doc, 0)
  return [...out]
}

export interface OpenedSpec {
  /** OpenAPI 3 document (a Swagger 2 input has been converted). */
  doc: any
  /** the input was Swagger 2 */
  converted: boolean
  warnings: string[]
}

/** Parse, and convert Swagger 2 to OpenAPI 3. Throws a readable error for anything that is not a spec. */
export async function openSpec(text: string): Promise<OpenedSpec> {
  const parsed = parseSpecText(text)
  const warnings: string[] = []
  let doc = parsed
  let converted = false
  if (typeof parsed.swagger === 'string' && parsed.swagger.startsWith('2')) {
    const res = await swagger2openapi.convertObj(parsed, {
      patch: true,
      warnOnly: true,
      resolve: false,
      direct: true,
    } as never)
    doc = typeof (res as any).openapi === 'object' ? (res as any).openapi : res
    converted = true
  } else if (typeof parsed.openapi !== 'string' || !parsed.openapi.startsWith('3')) {
    throw new Error(
      'This is not an OpenAPI 3 or Swagger 2 document (no "openapi" or "swagger" field)',
    )
  }
  if (!doc.paths || Object.keys(doc.paths).length === 0) warnings.push('The document has no paths.')
  const ext = externalRefs(doc)
  if (ext.length)
    warnings.push(
      `${ext.length} reference${ext.length > 1 ? 's' : ''} to other files were not loaded (for example ${ext[0]}).`,
    )
  return { doc, converted, warnings }
}

/** The data a UI reads for one spec: no TypeScript sources, and nothing written anywhere. */
export function generateData(
  doc: any,
  opts: Omit<GenerateOptions, 'spec'>,
  flags: GenerateFlags = {},
) {
  return generateFromDoc(doc, opts, { ...flags, dataOnly: true })
}
