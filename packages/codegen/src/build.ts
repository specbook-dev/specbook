import { conforms, makeValueIndex } from './hints'
import {
  clearExampleCaches,
  jsdoc,
  objectType,
  pascal,
  type Schema,
  safeIdent,
  sanitizeExample,
  synthesize,
  synthesizeVariant,
  toJsonSchema,
  tsType,
} from './schema'
import { unionOf } from './union'

export interface GenerateOptions {
  /** Path/URL to the spec, or an already-parsed object. */
  spec: string | object
  service: string
  /** Import specifier for the runtime package. */
  corePackage?: string
}

/**
 * The one-line label an operation is listed under: its summary, else the first line of its description.
 * Real specs leave `summary` out or set it to "" (Stripe does, for 16 of its 600 operations), and put
 * HTML in the description (`<p>List apple pay domains.</p>`), so both are cleaned; with nothing left there
 * is no label and the viewer shows the path.
 */
export function titleOf(op: { summary?: string; description?: string }): string | undefined {
  const plain = (s: string | undefined) =>
    (s ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
  const line = (s: string | undefined) =>
    plain(s)
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .find(Boolean)
  const text = line(op.summary) ?? line(op.description)
  if (!text) return undefined
  if (text.length <= 120) return text
  const cut = text.slice(0, 120)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 60))}…`
}

export interface GeneratedFile {
  path: string
  content: string
}

export interface ManifestExample {
  name: string
  title: string
  source: 'spec' | 'generated'
}

interface ExampleDoc {
  name: string
  title: string
  summary?: string
  source: 'spec' | 'generated'
  path?: Record<string, unknown>
  query?: Record<string, unknown>
  headers?: Record<string, unknown>
  body?: unknown
}

export interface ManifestOperation {
  id: string
  method: string
  path: string
  summary?: string
  description?: string
  tags: string[]
  statuses: number[]
  /**
   * The answers a status's example file holds, when there are several: a `oneOf` response (one per branch) or a
   * response with named `examples`. Keyed by status; the file is `{ "$variants": [...] }` (see core's `mock-variants`).
   */
  mockVariants?: Record<string, { name: string; title?: string; tag?: string }[]>
  examples: ManifestExample[]
  /** the spec requires credentials for this operation */
  secured?: boolean
  file: string
}

/** `info.x-logo` (a Redoc convention): only absolute http(s) or data-image URLs are trusted. */
export function logoOf(
  info: any,
): { url: string; altText?: string; backgroundColor?: string } | undefined {
  const l = info?.['x-logo']
  if (!l || typeof l.url !== 'string' || !/^(https?:\/\/|data:image\/)/i.test(l.url))
    return undefined
  return {
    url: l.url,
    ...(typeof l.altText === 'string' ? { altText: l.altText } : {}),
    ...(typeof l.backgroundColor === 'string' ? { backgroundColor: l.backgroundColor } : {}),
  }
}

/** Statuses a spec's `default` response stands in for (typed, mockable and listed in the manifest). */
export const DEFAULT_ERROR_STATUSES = [400, 401, 402, 403, 404, 409, 422, 429, 500]

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const
const BODY_ENCODINGS: [string, string][] = [
  ['application/json', 'json'],
  ['application/x-www-form-urlencoded', 'form'],
  ['multipart/form-data', 'multipart'],
  ['application/graphql', 'graphql'],
  ['text/plain', 'text'],
]
const BINARY_MIME = /^(application\/(octet-stream|pdf|zip|gzip)|(image|audio|video)\/)/
const WILDCARD_MIME = /^(\*|application)\/\*$/

function findJsonLike(content: Record<string, any> | undefined) {
  if (!content) return undefined
  for (const [mime, enc] of BODY_ENCODINGS) {
    if (content[mime])
      return {
        schema: content[mime].schema as Schema | undefined,
        encoding: enc,
        media: content[mime],
      }
  }
  const json = Object.keys(content).find((m) => /json/.test(m))
  if (json)
    return {
      schema: content[json].schema as Schema | undefined,
      encoding: 'json',
      media: content[json],
    }
  const binary = Object.keys(content).find((m) => BINARY_MIME.test(m))
  if (binary)
    return {
      schema: content[binary].schema as Schema | undefined,
      encoding: 'binary',
      media: content[binary],
      mediaType: binary,
    }
  // A wildcard stands for whatever the server sends, and a framework that is not told what it produces
  // declares every response that way (springdoc's `*/*`). It is JSON, unless the schema is a file.
  const any = Object.keys(content).find((m) => WILDCARD_MIME.test(m))
  if (any) {
    const schema = content[any].schema as Schema | undefined
    const file = schema?.format === 'binary'
    return {
      schema,
      encoding: file ? 'binary' : 'json',
      media: content[any],
      ...(file ? { mediaType: any } : {}),
    }
  }
  return undefined
}

/** The spec's per-field `encoding` (style/explode) as an array style, for form bodies. */
function formArrayStyles(media: any): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [field, e] of Object.entries<any>(media?.encoding ?? {})) {
    // deepObject is the bracket notation the default already writes (Stripe's `expand[]`)
    if (e?.style === 'deepObject') continue
    if (e?.style === 'spaceDelimited') out[field] = 'space'
    else if (e?.style === 'pipeDelimited') out[field] = 'pipe'
    else if (e?.explode === false) out[field] = 'comma'
    else if (e?.explode === true || e?.style === 'form') out[field] = 'repeat'
  }
  return out
}

const SAMPLE_FILE = 'sample.txt'
const SAMPLE_TEXT = 'specbook sample file\n'

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'example'

const isBinaryString = (s: Schema | undefined) =>
  s?.type === 'string' &&
  (s.format === 'binary' || s.contentEncoding === 'binary' || s.contentMediaType)

/** Dotted body paths of upload fields (`format: binary`), looking through refs and arrays. */
function fileFields(
  schema: Schema | undefined,
  resolve: (ref: string) => Schema | undefined,
  prefix = '',
  depth = 0,
): string[] {
  if (!schema || depth > 4) return []
  const s = schema.$ref ? resolve(schema.$ref) : schema
  if (!s) return []
  if (isBinaryString(s)) return prefix ? [prefix] : []
  if (s.type === 'array') return fileFields(s.items, resolve, prefix, depth + 1)
  return Object.entries<Schema>(s.properties ?? {}).flatMap(([k, v]) =>
    fileFields(v, resolve, prefix ? `${prefix}.${k}` : k, depth + 1),
  )
}

function setPaths(value: unknown, paths: string[], to: string): unknown {
  const walk = (node: unknown, keys: string[]): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, keys))
    if (keys.length === 0) return to
    const [head, ...rest] = keys as [string, ...string[]]
    if (node !== null && typeof node === 'object' && head in node)
      return { ...node, [head]: walk((node as Record<string, unknown>)[head], rest) }
    return node
  }
  return paths.reduce((acc, p) => walk(acc, p.split('.')), value)
}

function opId(method: string, path: string, given?: string): string {
  if (given) return pascal(given)
  const segs = path
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith('{') ? `By${pascal(s.slice(1, -1))}` : pascal(s)))
  return pascal(method) + segs.join('')
}

export interface GenerateFlags {
  /**
   * Produce only what a running UI reads (schemas, examples, docs, manifest, operation metadata) and skip
   * the TypeScript sources: `types.ts`, `operations/*.ts`, `tags/*.ts` and `index.ts`. The data files are
   * byte-identical to a full run; only the work and the files that are source code are left out.
   */
  dataOnly?: boolean
}

/** What a runtime needs to describe an operation without its generated module. */
export interface OperationMeta {
  service: string
  id: string
  method: string
  path: string
  encoding?: string
  mediaType?: string
  files?: string[]
  formArrays?: Record<string, string>
  security?: boolean
}

/** The generator proper, from an OpenAPI 3 document that is already parsed and bundled. */
export function generateFromDoc(
  doc: any,
  opts: Omit<GenerateOptions, 'spec'>,
  flags: GenerateFlags = {},
): {
  files: GeneratedFile[]
  operations: ManifestOperation[]
  metas: Record<string, OperationMeta>
} {
  try {
    return generateAll(doc, opts, flags)
  } finally {
    clearExampleCaches()
  }
}

function generateAll(
  doc: any,
  opts: Omit<GenerateOptions, 'spec'>,
  flags: GenerateFlags,
): {
  files: GeneratedFile[]
  operations: ManifestOperation[]
  metas: Record<string, OperationMeta>
} {
  const core = opts.corePackage ?? '@specbook/core'
  const ts = !flags.dataOnly
  const metas: Record<string, OperationMeta> = {}
  const schemas: Record<string, Schema> = doc.components?.schemas ?? {}
  const hasSchemes = Object.keys(doc.components?.securitySchemes ?? {}).length > 0
  const resolve = (ref: string): Schema | undefined => {
    const m = /^#\/components\/schemas\/(.+)$/.exec(ref)
    return m ? schemas[m[1] as string] : undefined
  }
  const resolveAny = <T>(obj: any): T => {
    if (obj?.$ref) {
      const parts = String(obj.$ref).replace(/^#\//, '').split('/')
      return parts.reduce((acc: any, p: string) => acc?.[p], doc) as T
    }
    return obj
  }
  const firstExample = (examples: Record<string, any> | undefined) =>
    resolveAny<any>(Object.values(examples ?? {})[0])?.value

  // what the spec says about a field elsewhere in the document; read on first use
  const index = makeValueIndex(doc)
  /**
   * What the example file of a response holds: a bare body, or when the spec gives several answers for the status, a
   * `{ "$variants": [...] }` envelope that the mock reads (core's `mock-variants`). Several named `examples` are those
   * answers; a union response has one per branch (found on the document's own schema, not the one written for the
   * browser, where `nullable` wraps a reference in an `anyOf`).
   */
  const responseExample = (
    media: any,
    schema: Schema,
    status: number,
  ): { file: unknown; variants?: { name: string; title?: string; tag?: string }[] } => {
    const used = new Set<string>()
    const unique = (name: string) => {
      let n = name
      while (used.has(n)) n += '-2'
      used.add(n)
      return n
    }
    const wrap = (list: { name: string; title?: string; tag?: string; body: unknown }[]) =>
      list.length < 2
        ? undefined
        : {
            file: { $variants: list },
            variants: list.map(({ body: _b, ...rest }) => rest),
          }
    if (media?.example !== undefined)
      return { file: sanitizeExample(media.example, '', undefined, status) }
    const fitting: { name: string; title?: string; body: unknown }[] = []
    for (const [key, raw] of Object.entries<any>(media?.examples ?? {})) {
      const ex = resolveAny<any>(raw)
      if (ex?.value === undefined) continue
      const body = sanitizeExample(ex.value, '', undefined, status)
      if (!conforms(schema, body, resolve)) continue
      fitting.push({
        name: unique(key),
        ...(typeof ex.summary === 'string' ? { title: ex.summary } : {}),
        body,
      })
    }
    const several = wrap(fitting)
    if (several) return several
    const root = schema.$ref ? resolve(schema.$ref) : schema
    const union = unionOf(root, { resolve })
    if (union && union.branches.length >= 2 && root) {
      used.clear()
      const list = union.branches.map((b, i) => {
        const target = b.schema.$ref ? resolve(b.schema.$ref) : b.schema
        const title = typeof target?.title === 'string' ? target.title : undefined
        return {
          name: unique(b.name ?? b.tag ?? `variant-${i + 1}`),
          ...(title && title !== b.name ? { title } : {}),
          ...(b.tag !== undefined ? { tag: b.tag } : {}),
          body: synthesizeVariant(root, union, i, resolve, status, false, index),
        }
      })
      // the spec's one example stands for the variant it names, not for all of them
      const only = fitting[0]
      if (only) {
        const at = union.tagProp
          ? list.findIndex(
              (v) =>
                v.tag !== undefined &&
                (only.body as Record<string, unknown>)?.[union.tagProp as string] === v.tag,
            )
          : -1
        const into = list[at >= 0 ? at : 0]
        if (into) into.body = only.body
      }
      return wrap(list) as ReturnType<typeof responseExample>
    }
    if (fitting[0]) return { file: fitting[0].body }
    return { file: synthesize(schema, resolve, 0, [], '', status, false, index) }
  }

  const files: GeneratedFile[] = []
  const operations: ManifestOperation[] = []

  const typeBlocks: string[] = []
  for (const [name, schema] of ts ? Object.entries(schemas) : []) {
    const id = pascal(name)
    const isObj =
      !schema.$ref &&
      !schema.enum &&
      !schema.allOf &&
      !schema.oneOf &&
      !schema.anyOf &&
      (schema.type === 'object' || (!schema.type && schema.properties)) &&
      schema.properties
    const body = isObj ? objectType(schema) : undefined
    typeBlocks.push(
      body?.startsWith('{')
        ? `${jsdoc(schema)}export interface ${id} ${body}`
        : `${jsdoc(schema)}export type ${id} = ${body ?? tsType(schema)}`,
    )
  }
  if (ts)
    files.push({
      path: 'types.ts',
      content: `// Generated by specbook codegen from the "${opts.service}" spec. Do not edit.\n\n${
        typeBlocks.join('\n\n') || 'export {}'
      }\n`,
    })

  // ---- JSON Schemas for the request editor (shared definitions + one small file per operation)
  const defsId = `specbook://${opts.service}/defs`
  files.push({
    path: 'schemas/definitions.schema.json',
    content: `${JSON.stringify({
      $id: defsId,
      $defs: Object.fromEntries(
        Object.entries(schemas).map(([name, sch]) => [pascal(name), toJsonSchema(sch, '#/$defs/')]),
      ),
    })}\n`,
  })

  // ---- operations
  const usedIds = new Set<string>()
  const byTag = new Map<string, string[]>()
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method]
      if (!op) continue
      let id = opId(method, path, op.operationId)
      while (usedIds.has(id)) id += '_'
      usedIds.add(id)

      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: any) =>
        resolveAny<any>(p),
      )
      const group = (where: string) =>
        params
          .filter((p: any) => p.in === where)
          .map((p: any) => ({
            name: p.name as string,
            required: where === 'path' ? true : Boolean(p.required),
            example: (p.example ?? firstExample(p.examples)) as unknown,
            schema: {
              ...(p.schema ?? {}),
              description: p.schema?.description ?? p.description,
            } as Schema,
          }))
      const paramType = (where: string) => {
        if (!ts) return undefined
        const g = group(where)
        if (!g.length) return undefined
        const schema: Schema = {
          type: 'object',
          properties: Object.fromEntries(g.map((p) => [p.name, p.schema])),
          required: g.filter((p) => p.required).map((p) => p.name),
        }
        return objectType(schema, '    ', 'T.')
      }
      const pathT = paramType('path')
      const queryT = paramType('query')
      const headerT = paramType('header')
      const paramsT = [
        pathT && `path: ${pathT}`,
        queryT && `query: ${queryT}`,
        headerT && `headers: ${headerT}`,
      ]
        .filter(Boolean)
        .join('; ')

      const reqBody = resolveAny<any>(op.requestBody)
      const body = findJsonLike(reqBody?.content)
      const bodyT = ts && body?.schema ? tsType(body.schema, '  ', 'T.') : 'never'

      const responseTypes: string[] = []
      const statuses: number[] = []
      const exampleFiles: GeneratedFile[] = []
      let defaultType: string | undefined
      let hasDefault = false
      let defaultSchema: Schema | undefined
      const responseSchemas: Record<string, Schema> = {}
      const mockVariants: NonNullable<ManifestOperation['mockVariants']> = {}
      let defaultVariants: ManifestOperation['mockVariants'] extends infer M
        ? M extends Record<string, infer V>
          ? V | undefined
          : never
        : never
      for (const [code, rawRes] of Object.entries<any>(op.responses ?? {})) {
        if (code === 'default') {
          const found = findJsonLike(resolveAny<any>(rawRes)?.content)
          if (found?.schema) {
            hasDefault = true
            if (ts) defaultType = tsType(found.schema, '  ', 'T.')
            defaultSchema = toJsonSchema(found.schema, `${defsId}#/$defs/`)
            const example = responseExample(found.media, found.schema, -1)
            defaultVariants = example.variants
            exampleFiles.push({
              path: `examples/${id}/default.response.json`,
              content: `${JSON.stringify(example.file, null, 2)}\n`,
            })
          }
          continue
        }
        if (!/^\d{3}$/.test(code)) continue
        const res = resolveAny<any>(rawRes)
        const found = findJsonLike(res?.content)
        statuses.push(Number(code))
        if (found?.schema) responseSchemas[code] = toJsonSchema(found.schema, `${defsId}#/$defs/`)
        if (ts)
          responseTypes.push(
            `${code}: ${found?.schema ? tsType(found.schema, '  ', 'T.') : 'unknown'}`,
          )
        if (found?.schema) {
          const example = responseExample(found.media, found.schema, Number(code))
          if (example.variants) mockVariants[code] = example.variants
          exampleFiles.push({
            path: `examples/${id}/${code}.response.json`,
            content: `${JSON.stringify(example.file, null, 2)}\n`,
          })
        }
      }
      if (hasDefault) {
        for (const st of DEFAULT_ERROR_STATUSES) {
          if (statuses.includes(st)) continue
          statuses.push(st)
          if (defaultSchema) responseSchemas[String(st)] = defaultSchema
          if (defaultVariants) mockVariants[String(st)] = defaultVariants
          if (defaultType) responseTypes.push(`${st}: ${defaultType}`)
        }
      }
      // ---- request examples: spec-defined first, then the generated default
      const fileFieldPaths = body?.encoding === 'multipart' ? fileFields(body.schema, resolve) : []
      const wholeBodyFile = body?.encoding === 'binary'
      const sample = `./${SAMPLE_FILE}`
      const paramsFor = () => {
        const pick = (where: string) => {
          const out: Record<string, unknown> = {}
          for (const p of group(where)) {
            if (p.example !== undefined) out[p.name] = p.example
            else if (p.required)
              out[p.name] = synthesize(p.schema, resolve, 0, [], p.name, undefined, false, index)
          }
          return Object.keys(out).length ? out : undefined
        }
        return { path: pick('path'), query: pick('query'), headers: pick('header') }
      }
      const bodyFor = (value: unknown) =>
        wholeBodyFile
          ? sample
          : fileFieldPaths.length
            ? setPaths(value, fileFieldPaths, sample)
            : value
      const docs: ExampleDoc[] = []
      const take = (name: string) => {
        let n = slug(name)
        while (docs.some((d) => d.name === n)) n += '-2'
        return n
      }
      for (const [key, raw] of Object.entries<any>(body?.media?.examples ?? {})) {
        const ex = resolveAny<any>(raw)
        if (ex?.value === undefined) continue
        docs.push({
          name: take(key),
          title: ex.summary ?? key,
          summary: ex.description,
          source: 'spec',
          ...paramsFor(),
          body: bodyFor(sanitizeExample(ex.value)),
        })
      }
      if (body?.media?.example !== undefined)
        docs.push({
          name: take('example'),
          title: 'Example',
          source: 'spec',
          ...paramsFor(),
          body: bodyFor(sanitizeExample(body.media.example)),
        })
      const plain = {
        ...paramsFor(),
        body: body?.schema
          ? bodyFor(synthesize(body.schema, resolve, 0, [], '', undefined, true, index))
          : undefined,
      }
      docs.push({ name: take('default'), title: 'Default', source: 'generated', ...plain })
      for (const d of docs)
        exampleFiles.push({
          path: `examples/${id}/${d.name}.example.json`,
          content: `${JSON.stringify(d, null, 2)}\n`,
        })
      if (wholeBodyFile || fileFieldPaths.length)
        exampleFiles.push({ path: `examples/${id}/${SAMPLE_FILE}`, content: SAMPLE_TEXT })
      files.push(...exampleFiles)

      // request editor schema: { path, query, headers, data }
      const refPrefix = `${defsId}#/$defs/`
      const section = (where: string) => {
        const g = group(where)
        if (!g.length) return undefined
        return {
          type: 'object',
          properties: Object.fromEntries(g.map((p) => [p.name, toJsonSchema(p.schema, refPrefix)])),
          required: g.filter((p) => p.required).map((p) => p.name),
        }
      }
      const requestSchema: Schema = {
        $id: `specbook://${opts.service}/${id}.request`,
        type: 'object',
        description: [op.summary, op.description].filter(Boolean).join('\n\n') || undefined,
        properties: {
          ...(section('path') ? { path: section('path') } : {}),
          ...(section('query') ? { query: section('query') } : {}),
          ...(section('header') ? { headers: section('header') } : {}),
          ...(body?.schema ? { data: toJsonSchema(body.schema, refPrefix) } : {}),
        },
        additionalProperties: false,
      }
      files.push({
        path: `schemas/${id}.responses.schema.json`,
        content: `${JSON.stringify(responseSchemas)}\n`,
      })
      files.push({
        path: `schemas/${id}.request.schema.json`,
        content: `${JSON.stringify(requestSchema)}\n`,
      })

      const effective = op.security ?? doc.security
      const secured = hasSchemes && Array.isArray(effective) && effective.length > 0
      const securityLine = !hasSchemes
        ? ''
        : `, security: ${Array.isArray(effective) && effective.length > 0 ? 'true' : 'false'}`
      // a binary body's declared type (`application/octet-stream`) is what the server expects as Content-Type
      const mediaType =
        body &&
        'mediaType' in body &&
        typeof body.mediaType === 'string' &&
        !body.mediaType.includes('*')
          ? body.mediaType
          : undefined
      const encodingLine =
        (body ? `, encoding: '${body.encoding}'` : '') +
        (mediaType ? `, mediaType: ${JSON.stringify(mediaType)}` : '')
      const arrayStyles = body?.encoding === 'form' ? formArrayStyles(body.media) : {}
      const arraysLine = Object.keys(arrayStyles).length
        ? `, formArrays: ${JSON.stringify(arrayStyles)}`
        : ''
      const filesLine = fileFieldPaths.length ? `, files: ${JSON.stringify(fileFieldPaths)}` : ''
      const summary = titleOf(op)

      metas[id] = {
        service: opts.service,
        id,
        method: method.toUpperCase(),
        path,
        ...(body ? { encoding: body.encoding } : {}),
        ...(mediaType ? { mediaType } : {}),
        ...(fileFieldPaths.length ? { files: fileFieldPaths } : {}),
        ...(Object.keys(arrayStyles).length ? { formArrays: arrayStyles } : {}),
        ...(hasSchemes ? { security: Array.isArray(effective) && effective.length > 0 } : {}),
      }
      if (ts)
        files.push({
          path: `operations/${id}.ts`,
          content: `import { defineOperation } from '${core}'
import type * as T from '../types'

${jsdoc({ description: [...new Set([op.summary, op.description].filter(Boolean))].join('\n\n'), deprecated: op.deprecated })}export const ${id} = /* @__PURE__ */ defineOperation<{
  params: { ${paramsT} }
  body: ${bodyT}
  responses: { ${responseTypes.join('; ')} }
}>({ service: ${JSON.stringify(opts.service)}, id: ${JSON.stringify(id)}, method: '${method.toUpperCase()}', path: ${JSON.stringify(path)}${encodingLine}${filesLine}${arraysLine}${securityLine} })
`,
        })
      const tags: string[] = op.tags?.length ? op.tags : ['default']
      for (const t of tags) byTag.set(t, [...(byTag.get(t) ?? []), id])
      // The long text stays out of the registry; the docs page loads it for the operation it shows.
      files.push({
        path: `docs/${id}.json`,
        content: `${JSON.stringify({
          ...(op.description && op.description !== summary ? { description: op.description } : {}),
          examples: docs.map((d) => ({ name: d.name, title: d.title, source: d.source })),
        })}\n`,
      })
      operations.push({
        id,
        method: method.toUpperCase(),
        path,
        summary,
        ...(op.description && op.description !== summary ? { description: op.description } : {}),
        tags,
        statuses,
        ...(Object.keys(mockVariants).length ? { mockVariants } : {}),
        examples: docs.map((d) => ({ name: d.name, title: d.title, source: d.source })),
        ...(secured ? { secured: true } : {}),
        file: `operations/${id}.ts`,
      })
    }
  }

  // ---- index + per-tag barrels + manifest
  const exportsFor = (ids: string[]) =>
    ids
      .sort()
      .map((i) => `export { ${i} } from './operations/${i}'`)
      .join('\n')
  if (ts)
    files.push({
      path: 'index.ts',
      content: `${exportsFor([...usedIds])}\nexport type * from './types'\n`,
    })
  for (const [tag, ids] of ts ? byTag : []) {
    files.push({
      path: `tags/${safeIdent(tag)}.ts`,
      content: `${exportsFor(ids).replace(/'\.\/operations/g, "'../operations")}\n`,
    })
  }
  // what a run needs of each operation (method, path, encoding…): the committed operations file is built from it
  if (ts) files.push({ path: 'opmeta.json', content: `${JSON.stringify(metas, null, 2)}\n` })
  files.push({
    path: 'manifest.json',
    content: `${JSON.stringify(
      {
        service: opts.service,
        title: doc.info?.title,
        version: doc.info?.version,
        ...(logoOf(doc.info) ? { logo: logoOf(doc.info) } : {}),
        servers: (doc.servers ?? []).map((s: any) => s.url),
        tags: [...byTag.keys()],
        operations,
      },
      null,
      2,
    )}\n`,
  })
  return { files, operations, metas }
}
