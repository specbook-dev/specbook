import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { generate, generateToDisk } from '../src'

const run = promisify(execFile)
const fx = (n: string) => resolve(__dirname, 'fixtures', n)
const coreEntry = resolve(__dirname, '../../core/src/index.ts')
const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

describe('petstore 3.0', () => {
  it('generates types, operations, examples, tags and a manifest', async () => {
    const { files, operations } = await generate({
      spec: fx('petstore3.json'),
      service: 'petstore',
    })
    const paths = files.map((f) => f.path)
    expect(operations.map((o) => o.id)).toEqual(
      expect.arrayContaining([
        'AddPet',
        'FindPetsByStatus',
        'GetPetById',
        'PlaceOrder',
        'GetOrderById',
        'LoginUser',
      ]),
    )
    expect(paths).toContain('operations/AddPet.ts')
    expect(paths).toContain('examples/AddPet/default.example.json')
    expect(paths.some((p) => p.endsWith('dynamic.example.json'))).toBe(false)
    expect(paths).toContain('examples/AddPet/200.response.json')
    expect(paths.some((p) => /^examples\/[^/]+\.json$/.test(p))).toBe(false)
    expect(paths).toContain('tags/pet.ts')
    const types = files.find((f) => f.path === 'types.ts')?.content ?? ''
    expect(types).toContain('export interface Pet {')
    expect(types).toMatch(/status\?: "available" \| "pending" \| "sold"/)
    const getPet = files.find((f) => f.path === 'operations/GetPetById.ts')?.content ?? ''
    expect(getPet).toContain('path: {')
    expect(getPet).toContain('200: T.Pet')
    expect(getPet).toContain("method: 'GET'")
    expect(getPet).toContain('path: "/pet/{petId}"')
    const login = files.find((f) => f.path === 'operations/LoginUser.ts')?.content ?? ''
    expect(login).toContain('security: false')
  })

  it('example JSON is valid and uses spec examples where present', async () => {
    const { files } = await generate({ spec: fx('petstore3.json'), service: 'petstore' })
    const read = (path: string) => JSON.parse(files.find((f) => f.path === path)?.content ?? 'null')
    const def = read('examples/AddPet/default.example.json')
    expect(def).toMatchObject({ name: 'default', source: 'generated' })
    expect(def.body.name).toBe('doggie')
    expect(def.body.status).toBe('available')
    const get = read('examples/GetPetById/default.example.json')
    expect(get.path).toEqual({ petId: expect.any(Number) })
  })

  it('lists examples in the manifest', async () => {
    const { operations } = await generate({ spec: fx('petstore3.json'), service: 'petstore' })
    const add = operations.find((o) => o.id === 'AddPet')
    expect(add?.examples.map((e) => e.name)).toContain('default')
    expect(add?.examples.map((e) => e.name)).not.toContain('dynamic')
  })
})

describe('generated examples never carry faker placeholders', () => {
  it('has no dynamic example and no placeholder in the default', async () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'T', version: '1' },
      paths: {
        '/users': {
          post: {
            operationId: 'createUser',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      email: { type: 'string', format: 'email' },
                      role: { type: 'string', enum: ['admin', 'member'] },
                    },
                  },
                },
              },
            },
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    }
    const { files } = await generate({ spec, service: 'svc' })
    expect(files.some((f) => f.path.endsWith('dynamic.example.json'))).toBe(false)
    const def = JSON.parse(
      files.find((f) => f.path === 'examples/CreateUser/default.example.json')?.content ?? 'null',
    )
    expect(JSON.stringify(def)).not.toContain('{{faker')
    expect(def.body.role).toBe('admin')
  })
})

describe('request examples from a spec', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'T', version: '1' },
    paths: {
      '/things/{id}': {
        post: {
          operationId: 'upload',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'abc' },
            {
              name: 'tag',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
              examples: { a: { value: ['x', 'y'] } },
            },
            { name: 'trace', in: 'query', schema: { type: 'string' } },
          ],
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    caption: { type: 'string' },
                    photo: { type: 'string', format: 'binary' },
                  },
                },
                examples: {
                  'With caption': { summary: 'Captioned', value: { caption: 'hi', photo: 'x' } },
                },
              },
            },
          },
          responses: { 200: { description: 'ok' } },
        },
      },
      '/blob': {
        put: {
          operationId: 'putBlob',
          requestBody: {
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  }

  it('uses named spec examples, parameter examples, and omits optional params', async () => {
    const { files } = await generate({ spec, service: 'svc' })
    const read = (path: string) => JSON.parse(files.find((f) => f.path === path)?.content ?? 'null')
    const named = read('examples/Upload/with-caption.example.json')
    expect(named).toMatchObject({ title: 'Captioned', source: 'spec' })
    expect(named.path).toEqual({ id: 'abc' })
    expect(named.query).toEqual({ tag: ['x', 'y'] })
  })

  it('points upload fields at a generated sample file', async () => {
    const { files } = await generate({ spec, service: 'svc' })
    const paths = files.map((f) => f.path)
    expect(paths).toContain('examples/Upload/sample.txt')
    const def = JSON.parse(
      files.find((f) => f.path === 'examples/Upload/default.example.json')?.content ?? 'null',
    )
    expect(def.body.photo).toBe('./sample.txt')
    const op = files.find((f) => f.path === 'operations/Upload.ts')?.content ?? ''
    expect(op).toContain('encoding: \'multipart\', files: ["photo"]')

    const blob = JSON.parse(
      files.find((f) => f.path === 'examples/PutBlob/default.example.json')?.content ?? 'null',
    )
    expect(blob.body).toBe('./sample.txt')
    expect(files.find((f) => f.path === 'operations/PutBlob.ts')?.content).toContain(
      "encoding: 'binary'",
    )
    // the declared type travels with the operation, so the upload is sent as the spec says
    expect(files.find((f) => f.path === 'operations/PutBlob.ts')?.content).toContain(
      'mediaType: "application/octet-stream"',
    )
  })
})

describe('petstore 2.0 (swagger) is normalised', () => {
  it('yields the same operation ids', async () => {
    const { operations } = await generate({ spec: fx('petstore2.json'), service: 'petstore' })
    const ids = operations.map((o) => o.id)
    expect(ids).toEqual(expect.arrayContaining(['AddPet', 'GetPetById', 'PlaceOrder']))
  })
})

describe('generated code compiles against @specbook/core', () => {
  // TypeScript 7 has no JS compiler API, so type-check by running the tsc CLI.
  it.each(['petstore3.json', 'petstore2.json'])(
    '%s',
    async (name) => {
      const outDir = await mkdtemp(join(tmpdir(), 'specbook-gen-'))
      dirs.push(outDir)
      await generateToDisk({ spec: fx(name), service: 'petstore', outDir })
      const tsconfig = join(outDir, 'tsconfig.json')
      await writeFile(
        tsconfig,
        JSON.stringify({
          compilerOptions: {
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            lib: ['ES2022', 'DOM'],
            types: [],
            paths: { '@specbook/core': [coreEntry] },
          },
          files: [join(outDir, 'petstore/index.ts')],
        }),
      )
      const tsc = resolve(__dirname, '../node_modules/.bin/tsc')
      const r = await run(tsc, ['-p', tsconfig]).catch((e) => e)
      expect(r.stdout ?? String(r)).toBe('')
    },
    60_000,
  )
})

describe('request editor JSON Schemas', () => {
  it('emits shared definitions and a small per-operation request schema with docs', async () => {
    const { files } = await generate({ spec: fx('petstore3.json'), service: 'petstore' })
    const defs = JSON.parse(
      files.find((f) => f.path === 'schemas/definitions.schema.json')?.content ?? '{}',
    )
    expect(defs.$defs.Pet.properties.name.type).toBe('string')
    // numbers accept a "{{variable}}" placeholder
    expect(defs.$defs.Pet.properties.id.anyOf).toHaveLength(2)
    expect(defs.$defs.Pet.properties.status.description).toMatch(/status/i)

    const op = JSON.parse(
      files.find((f) => f.path === 'schemas/GetPetById.request.schema.json')?.content ?? '{}',
    )
    expect(op.properties.path.properties.petId).toBeDefined()
    expect(op.properties.path.required).toEqual(['petId'])
    const add = JSON.parse(
      files.find((f) => f.path === 'schemas/AddPet.request.schema.json')?.content ?? '{}',
    )
    expect(add.properties.data.$ref).toBe('specbook://petstore/defs#/$defs/Pet')
  })
})

describe('human-readable example data', () => {
  it('uses names, formats and common field names instead of "string"/1', async () => {
    const { synthesize } = await import('../src')
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        login: { type: 'string' },
        email: { type: 'string' },
        html_url: { type: 'string' },
        emojis_url: { type: 'string' },
        created_at: { type: 'string', format: 'date-time' },
        description: { type: 'string' },
        private: { type: 'boolean' },
        labels: { type: 'array', items: { type: 'string' } },
        zen: { type: 'string' },
      },
    }
    const ex = synthesize(schema, () => undefined) as Record<string, unknown>
    expect(ex.login).toBe('octocat')
    expect(ex.email).toBe('jane.doe@example.com')
    expect(ex.html_url).toBe('https://example.com')
    expect(ex.emojis_url).toBe('https://api.example.com/emojis')
    expect(ex.created_at).toBe('2024-05-14T09:30:00Z')
    expect(ex.private).toBe(false)
    expect(ex.zen).toBe('Example zen')
    expect(JSON.stringify(ex)).not.toContain('"string"')
  })

  it('emits one response schema per status', async () => {
    const { files } = await generate({ spec: fx('petstore3.json'), service: 'petstore' })
    const r = JSON.parse(
      files.find((f) => f.path === 'schemas/GetPetById.responses.schema.json')?.content ?? '{}',
    )
    expect(r['200'].$ref).toBe('specbook://petstore/defs#/$defs/Pet')
  })
})

describe('error responses read like errors', () => {
  it('fills message/status from the response code, not with a success message', async () => {
    const { synthesize } = await import('../src')
    const err = {
      type: 'object',
      properties: {
        message: { type: 'string' },
        status: { type: 'string' },
        documentation_url: { type: 'string' },
      },
    }
    const forbidden = synthesize(err, () => undefined, 0, [], '', 403) as Record<string, string>
    expect(forbidden.message).toBe('Forbidden')
    expect(forbidden.status).toBe('403')
    const unknown = synthesize(err, () => undefined, 0, [], '', -1) as Record<string, string>
    expect(unknown.message).not.toMatch(/success/i)
    const ok = synthesize(err, () => undefined, 0, [], '', 200) as Record<string, string>
    expect(ok.message).toMatch(/success/i)
  })
})

describe('form array styles', () => {
  it("keeps the spec's per-field style/explode in the operation meta", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'specbook-form-'))
    dirs.push(dir)
    const spec = join(dir, 'api.json')
    const field = { type: 'array', items: { type: 'string' } }
    await writeFile(
      spec,
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Forms', version: '1' },
        paths: {
          '/things': {
            post: {
              operationId: 'CreateThing',
              requestBody: {
                content: {
                  'application/x-www-form-urlencoded': {
                    schema: {
                      type: 'object',
                      properties: { ids: field, tags: field, expand: field },
                    },
                    encoding: {
                      ids: { style: 'form', explode: true },
                      tags: { style: 'form', explode: false },
                      expand: { style: 'deepObject', explode: true },
                    },
                  },
                },
              },
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      }),
    )
    const { files } = await generate({ spec, service: 'forms' })
    const op = files.find((f) => f.path === 'operations/CreateThing.ts')?.content ?? ''
    expect(op).toContain('formArrays: {"ids":"repeat","tags":"comma"}')
  })
})

describe('sparse request examples', () => {
  it('keeps required and documented fields, not every optional one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'specbook-sparse-'))
    dirs.push(dir)
    const spec = join(dir, 'api.json')
    const str = { type: 'string' }
    await writeFile(
      spec,
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Sparse', version: '1' },
        paths: {
          '/things': {
            post: {
              operationId: 'CreateThing',
              requestBody: {
                content: {
                  'application/x-www-form-urlencoded': {
                    schema: {
                      type: 'object',
                      properties: {
                        zeta: str,
                        description: str,
                        address: { type: 'object', properties: { city: str, line1: str } },
                        name: str,
                        email: str,
                        notes: str,
                        phone: str,
                      },
                    },
                  },
                },
              },
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      }),
    )
    const { files } = await generate({ spec, service: 'sparse' })
    const ex = JSON.parse(
      files.find((f) => f.path === 'examples/CreateThing/default.example.json')?.content ?? '{}',
    )
    // nothing is required or documented, so a few common scalars stand in, never the nested object
    expect(Object.keys(ex.body)).toEqual(['zeta', 'description', 'name', 'email'])
  })
})

describe('x-logo', () => {
  const base = (info: object) => ({
    openapi: '3.0.3',
    info: { title: 'Logo', version: '1', ...info },
    paths: { '/a': { get: { operationId: 'A', responses: { '200': { description: 'ok' } } } } },
  })
  const manifest = async (info: object) => {
    const dir = await mkdtemp(join(tmpdir(), 'specbook-logo-'))
    dirs.push(dir)
    const spec = join(dir, 'api.json')
    await writeFile(spec, JSON.stringify(base(info)))
    const { files } = await generate({ spec, service: 'logo' })
    return JSON.parse(files.find((f) => f.path === 'manifest.json')?.content ?? '{}')
  }

  it('carries info.x-logo into the manifest', async () => {
    const m = await manifest({
      'x-logo': { url: 'https://cdn.test/logo.svg', altText: 'Acme', backgroundColor: '#000' },
    })
    expect(m.logo).toEqual({
      url: 'https://cdn.test/logo.svg',
      altText: 'Acme',
      backgroundColor: '#000',
    })
  })

  it('ignores relative and script URLs', async () => {
    expect((await manifest({ 'x-logo': { url: './logo.png' } })).logo).toBeUndefined()
    expect((await manifest({ 'x-logo': { url: 'javascript:alert(1)' } })).logo).toBeUndefined()
    expect((await manifest({})).logo).toBeUndefined()
  })
})

describe('example quality', () => {
  const run = async (schemas: Record<string, unknown>, root: unknown) => {
    const dir = await mkdtemp(join(tmpdir(), 'specbook-quality-'))
    dirs.push(dir)
    const spec = join(dir, 'api.json')
    await writeFile(
      spec,
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Q', version: '1' },
        paths: {
          '/things': {
            post: {
              operationId: 'CreateThing',
              requestBody: { content: { 'application/json': { schema: root } } },
              responses: {
                '200': { description: 'ok', content: { 'application/json': { schema: root } } },
              },
            },
          },
        },
        components: { schemas },
      }),
    )
    const { files } = await generate({ spec, service: 'q' })
    const read = (p: string) => JSON.parse(files.find((f) => f.path === p)?.content ?? 'null')
    return {
      request: read('examples/CreateThing/default.example.json').body,
      response: read('examples/CreateThing/200.response.json'),
    }
  }

  it('replaces placeholder examples such as "string" with a sensible value for the field', async () => {
    const { request, response } = await run(
      {},
      {
        type: 'object',
        properties: {
          email: { type: 'string', example: 'string' },
          city: { type: 'string', example: 'string' },
          nickname: { type: 'string', example: 'Rex' },
          tags: { type: 'array', items: { type: 'string' }, example: ['string'] },
        },
      },
    )
    expect(request).toMatchObject({
      email: 'jane.doe@example.com',
      city: 'Seattle',
      nickname: 'Rex',
    })
    expect(response.tags[0]).not.toBe('string')
  })

  it('never writes null for a deep or recursive schema, and keeps required fields', async () => {
    const deep = (n: number): object =>
      n === 0
        ? { type: 'object', required: ['leaf'], properties: { leaf: { type: 'string' } } }
        : { type: 'object', required: ['next'], properties: { next: deep(n - 1) } }
    const { response } = await run(
      {
        Node: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            child: { $ref: '#/components/schemas/Node' },
            kids: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
          },
        },
      },
      {
        type: 'object',
        properties: { tree: { $ref: '#/components/schemas/Node' }, deep: deep(9) },
      },
    )
    expect(JSON.stringify(response)).not.toContain('null')
    let d = response.deep
    for (let i = 0; i < 9; i++) d = d.next
    expect(typeof d.leaf).toBe('string')
    expect(typeof response.tree.name).toBe('string')
  })

  it('keeps an enum example that looks like a placeholder, but not one outside the enum', async () => {
    const { response } = await run(
      {},
      {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['text', 'value'], example: 'text' },
          mode: { type: 'string', enum: ['fast', 'slow'], example: 'medium' },
        },
      },
    )
    expect(response.kind).toBe('text')
    expect(response.mode).toBe('fast')
  })

  it('treats nullable next to allOf as nullable in the JSON Schema', async () => {
    const { toJsonSchema } = await import('../src/schema')
    const out = toJsonSchema(
      { nullable: true, allOf: [{ $ref: '#/components/schemas/User' }] },
      '#/$defs/',
    )
    expect(out.anyOf).toEqual([
      expect.objectContaining({ allOf: expect.any(Array) }),
      { type: 'null' },
    ])
  })

  it('ignores an example whose type contradicts its schema', async () => {
    const { response } = await run(
      {},
      {
        type: 'object',
        properties: {
          host: { type: 'string', example: ['example.com'] },
          ok: { type: 'boolean', enum: [true] },
        },
      },
    )
    expect(typeof response.host).toBe('string')
    expect(response.ok).toBe(true)
  })
})

describe('examples', () => {
  it('prefer a real value over the empty string an enum lists to clear a field', async () => {
    const { synthesize } = await import('../src')
    const resolve = () => undefined
    expect(synthesize({ type: 'string', enum: ['', 'exempt', 'none'] }, resolve)).toBe('exempt')
    // an enum that is only the empty string keeps it
    expect(synthesize({ type: 'string', enum: [''] }, resolve)).toBe('')
    expect(synthesize({ type: 'string', enum: ['a', 'b'] }, resolve)).toBe('a')
  })
})
