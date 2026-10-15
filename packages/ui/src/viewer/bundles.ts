import type { GeneratedFile } from '@specbook/codegen/browser'

/** Raw JSON text of what one operation's page needs, assembled without parsing it. */
export interface OpParts {
  schema?: string
  responses?: string
  docs?: string
  examples: Record<string, string>
  mock: Record<string, string>
}

export interface Parts {
  ops: Map<string, OpParts>
  definitions: string
  manifest: string
}

const trim = (s: string) => s.trimEnd()

/**
 * Sorts a data-only `generate` run into the same per-operation bundles the static build writes
 * (`{ schema, responses, docs?, examples, mock }`), keeping each piece as the JSON text it already is.
 */
export function sortFiles(files: GeneratedFile[]): Parts {
  const ops = new Map<string, OpParts>()
  const at = (id: string) => {
    const have = ops.get(id)
    if (have) return have
    const fresh: OpParts = { examples: {}, mock: {} }
    ops.set(id, fresh)
    return fresh
  }
  let definitions = '{}'
  let manifest = '{}'
  for (const f of files) {
    const parts = f.path.split('/')
    if (f.path === 'schemas/definitions.schema.json') definitions = trim(f.content)
    else if (f.path === 'manifest.json') manifest = f.content
    else if (parts[0] === 'schemas' && parts[1]?.endsWith('.request.schema.json'))
      at(parts[1].replace(/\.request\.schema\.json$/, '')).schema = trim(f.content)
    else if (parts[0] === 'schemas' && parts[1]?.endsWith('.responses.schema.json'))
      at(parts[1].replace(/\.responses\.schema\.json$/, '')).responses = trim(f.content)
    else if (parts[0] === 'docs' && parts[1]?.endsWith('.json')) {
      // nothing worth a file or a request: no text, and no examples beyond the generated pair
      const d = JSON.parse(f.content) as { description?: string; examples?: unknown[] }
      if (d.description || (d.examples?.length ?? 0) > 2)
        at(parts[1].replace(/\.json$/, '')).docs = trim(f.content)
    } else if (parts[0] === 'examples' && parts.length === 3) {
      const [, id, file] = parts as [string, string, string]
      if (file.endsWith('.example.json'))
        at(id).examples[file.replace(/\.example\.json$/, '')] = trim(f.content)
      else if (file.endsWith('.response.json'))
        at(id).mock[file.replace(/\.response\.json$/, '')] = trim(f.content)
    }
  }
  return { ops, definitions, manifest }
}

const obj = (entries: Record<string, string>) =>
  `{${Object.entries(entries)
    .map(([k, v]) => `${JSON.stringify(k)}:${v}`)
    .join(',')}}`

/** The JSON text of one operation's bundle. */
export function bundleJson(p: OpParts | undefined): string {
  if (!p) return '{}'
  const out: string[] = []
  if (p.schema) out.push(`"schema":${p.schema}`)
  if (p.responses) out.push(`"responses":${p.responses}`)
  if (p.docs) out.push(`"docs":${p.docs}`)
  if (Object.keys(p.examples).length) out.push(`"examples":${obj(p.examples)}`)
  if (Object.keys(p.mock).length) out.push(`"mock":${obj(p.mock)}`)
  return `{${out.join(',')}}`
}
