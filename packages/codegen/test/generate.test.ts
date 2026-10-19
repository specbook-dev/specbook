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

  it('keeps a null branch of anyOf as a null (OpenAPI 3.1 optional fields)', async () => {
    const { toJsonSchema } = await import('../src/schema')
    const out = toJsonSchema(
      { anyOf: [{ type: 'integer' }, { type: 'null' }], title: 'Owner Id' },
      '#/$defs/',
    )
    expect(out.anyOf).toEqual([
      expect.objectContaining({ anyOf: expect.any(Array) }),
      { type: 'null' },
    ])
    expect(out.title).toBe('Owner Id')
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

describe('values derived from the spec', () => {
  const none = () => undefined
  const make = async () => (await import('../src/schema')).synthesize
  const hints = () => import('../src/hints')

  it('reads const and the first of examples', async () => {
    const synthesize = await make()
    expect(synthesize({ type: 'string', const: 'fixed' }, none)).toBe('fixed')
    expect(synthesize({ type: 'string', examples: ['first', 'second'] }, none)).toBe('first')
  })

  it('takes a value a description names, and ignores one it does not', async () => {
    const { fromDescription } = await hints()
    expect(fromDescription('Name of the bank (e.g., `WELLS FARGO`).')).toBe('WELLS FARGO')
    expect(fromDescription('Can be `amex`, `visa` or `unknown`.')).toBe('amex')
    expect(fromDescription('The options are:  \n**For a team:**  \n * `secret` - hidden')).toBe(
      'secret',
    )
    expect(fromDescription('Defaults to the `id` of the Payment Intent.')).toBeUndefined()
    expect(fromDescription('Defaults to `false` when unset.')).toBeUndefined()
    const synthesize = await make()
    expect(
      synthesize(
        { type: 'string', description: 'The card brand, e.g. `visa`.' },
        none,
        0,
        [],
        'brand',
      ),
    ).toBe('visa')
  })

  it('borrows an example the spec gives the same field elsewhere, but not for a generic name', async () => {
    const { makeValueIndex } = await hints()
    const synthesize = await make()
    const index = makeValueIndex({
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              username: { type: 'string', example: 'theUser' },
              name: { type: 'string', example: 'Rex' },
              quantity: { type: 'integer', example: 7 },
            },
          },
        },
      },
    })
    const s = { type: 'string' }
    expect(synthesize(s, none, 0, [], 'username', undefined, false, index)).toBe('theUser')
    expect(synthesize(s, none, 0, [], 'name', undefined, false, index)).toBe('Example name')
    expect(synthesize({ type: 'integer' }, none, 0, [], 'quantity', undefined, false, index)).toBe(
      7,
    )
  })

  it('answers a pattern, and keeps to length limits', async () => {
    const { fromPattern } = await hints()
    const synthesize = await make()
    for (const p of [
      '^sha256:[a-f0-9]{64}$',
      'prefix_[a-zA-Z0-9]{32}',
      '[a-z]+_token_[0-9]+',
      '^(a|b)\\d{2}$',
    ])
      expect(new RegExp(p).test(fromPattern(p) as string)).toBe(true)
    expect(fromPattern('(?=x)y')).toBeUndefined()
    const code = synthesize(
      { type: 'string', pattern: '^[A-Z]{3}-\\d{4}$' },
      none,
      0,
      [],
      'ref',
    ) as string
    expect(code).toMatch(/^[A-Z]{3}-\d{4}$/)
    expect(synthesize({ type: 'string', maxLength: 4 }, none, 0, [], 'zen')).toHaveLength(4)
    expect(synthesize({ type: 'string', minLength: 12 }, none, 0, [], 'zen')).toHaveLength(12)
  })

  it('keeps numbers inside their bounds and multiples', async () => {
    const synthesize = await make()
    expect(
      synthesize({ type: 'integer', minimum: 5000, maximum: 9000 }, none, 0, [], 'amount'),
    ).toBe(5000)
    expect(synthesize({ type: 'integer', maximum: 10 }, none, 0, [], 'amount')).toBe(10)
    expect(synthesize({ type: 'integer', exclusiveMinimum: 0 }, none, 0, [], 'x')).toBe(1)
    expect(synthesize({ type: 'integer', multipleOf: 25 }, none, 0, [], 'x')).toBe(25)
  })

  it('writes as many array items as the schema needs, and none when it allows none', async () => {
    const synthesize = await make()
    const items = { type: 'string' }
    expect(synthesize({ type: 'array', items, minItems: 3 }, none, 0, [], 'tags')).toHaveLength(3)
    const unique = synthesize(
      { type: 'array', items, minItems: 2, uniqueItems: true },
      none,
      0,
      [],
      'tags',
    ) as string[]
    expect(new Set(unique).size).toBe(2)
    expect(synthesize({ type: 'array', items, maxItems: 0 }, none, 0, [], 'tags')).toEqual([])
  })

  it('leaves out read-only fields of a request and write-only fields of a response', async () => {
    const synthesize = await make()
    const schema = {
      type: 'object',
      required: ['secret'],
      properties: {
        id: { type: 'integer', readOnly: true },
        token: { type: 'string', writeOnly: true },
        secret: { type: 'string', writeOnly: true },
        note: { type: 'string' },
      },
    }
    expect(Object.keys(synthesize(schema, none) as object)).toEqual(['token', 'secret', 'note'])
    expect(Object.keys(synthesize(schema, none, 0, [], '', 200) as object)).toEqual([
      'id',
      'secret',
      'note',
    ])
  })

  it('shows the real branch of a nullable anyOf, and sets a discriminator', async () => {
    const synthesize = await make()
    const resolve = (ref: string) =>
      ref.endsWith('Cat')
        ? { type: 'object', properties: { kind: { type: 'string' }, lives: { type: 'integer' } } }
        : undefined
    expect(
      synthesize({ anyOf: [{ type: 'null' }, { type: 'integer' }] }, none, 0, [], 'count'),
    ).toBe(3)
    const pet = synthesize(
      {
        oneOf: [{ $ref: '#/components/schemas/Cat' }],
        discriminator: { propertyName: 'kind', mapping: { feline: '#/components/schemas/Cat' } },
      },
      resolve,
    ) as Record<string, unknown>
    expect(pet.kind).toBe('feline')
  })

  it('reads the standard a description cites, and invents no values of its own', async () => {
    const { fromDescription } = await hints()
    const synthesize = await make()
    expect(fromDescription('Three-letter ISO currency code, in lowercase.')).toBe('usd')
    expect(fromDescription('Two-letter country code ([ISO 3166-1 alpha-2](https://x)).')).toBe('US')
    expect(fromDescription('The last four digits of the card.')).toBe('4242')
    expect(
      fromDescription('The close-out date in ISO 8601 format. E.g. 2023-12-31 for the 31st.'),
    ).toBe('2023-12-31')
    expect(
      fromDescription('Three-letter [ISO code for the currency](https://x) it is charged in.'),
    ).toBe('usd')
    expect(fromDescription('The display name of the currency.')).toBeUndefined()
    expect(synthesize({ type: 'string' }, none, 0, [], 'settlement_currency')).toBe('usd')
    expect(fromDescription('Last four characters of the IBAN.')).toBe('4242')
    expect(fromDescription('A date string in YYYY-MM-DD format.')).toBe('2024-05-14')
    expect(fromDescription('ID of the mandate used to make this payment.')).toBe('a1b2c3d4')
    expect(fromDescription('Unique identifier for the object.')).toBe('a1b2c3d4')
    expect(fromDescription('The URL of the mandate.')).toBe('https://example.com/resource')
    expect(fromDescription("The customer's phone number.")).toBe('+1-555-0100')
    expect(fromDescription('Whether the holder is verified, see the docs.')).toBeUndefined()
    const s = (description: string) => ({ type: 'string', description })
    expect(synthesize(s('Three-letter ISO currency code.'), none, 0, [], 'default_currency')).toBe(
      'usd',
    )
    // a status the spec does not list is not guessed from the field's last word
    expect(synthesize({ type: 'string' }, none, 0, [], 'petStatus')).toBe('Example pet status')
  })

  it('gives a link to an image a file of the type its name says', async () => {
    const synthesize = await make()
    const s = { type: 'string' }
    expect(synthesize(s, none, 0, [], 'image_url_png')).toBe('https://api.example.com/image.png')
    expect(synthesize(s, none, 0, [], 'qr_code_url_svg')).toBe(
      'https://api.example.com/qr_code.svg',
    )
  })

  it('uses a named response example from the spec', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'specbook-named-'))
    dirs.push(dir)
    const spec = join(dir, 'api.json')
    await writeFile(
      spec,
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'N', version: '1' },
        paths: {
          '/pets': {
            get: {
              operationId: 'ListPets',
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: { type: 'object', properties: { nickname: { type: 'string' } } },
                      examples: { rex: { value: { nickname: 'Rex' } } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    )
    const { files } = await generate({ spec, service: 'n' })
    const ex = files.find((f) => f.path === 'examples/ListPets/200.response.json')
    expect(JSON.parse(ex?.content ?? 'null')).toEqual({ nickname: 'Rex' })
  })
})

describe('round 2: what the spec still says', () => {
  const none = () => undefined
  const loaded = async () => ({
    ...(await import('../src/schema')),
    ...(await import('../src/hints')),
  })
  const string = { type: 'string' }

  it('reads the description a wrapper gives its string branch', async () => {
    const { synthesize } = await loaded()
    const wrapper = {
      description: 'The ID of the customer that owns this.',
      anyOf: [{ type: 'string', maxLength: 5000 }, { $ref: '#/components/schemas/customer' }],
    }
    expect(synthesize(wrapper, none, 0, [], 'customer')).toBe('a1b2c3d4')
  })

  it('borrows an enum or described value from the same field elsewhere, after the name rules, and not for status', async () => {
    const { synthesize, makeValueIndex } = await loaded()
    const index = makeValueIndex({
      components: {
        schemas: {
          Card: {
            type: 'object',
            properties: {
              brand: { type: 'string', enum: ['visa', 'amex'] },
              funding: {
                type: 'string',
                description: 'Card funding type. Can be `credit` or `debit`.',
              },
              status: { type: 'string', enum: ['pending'] },
            },
          },
        },
      },
    })
    const call = (key: string) => synthesize(string, none, 0, [], key, undefined, false, index)
    expect(call('brand')).toBe('visa')
    expect(call('funding')).toBe('credit')
    expect(call('status')).toBe('active')
    // a name rule beats a borrowed enum value
    const country = makeValueIndex({ properties: { country: { type: 'string', enum: ['AT'] } } })
    expect(synthesize(string, none, 0, [], 'country', undefined, false, country)).toBe('US')
  })

  it('writes unix times and the parts of a date as such', async () => {
    const { synthesize } = await loaded()
    const int = { type: 'integer' }
    expect(synthesize({ ...int, format: 'unix-time' }, none, 0, [], 'whenever')).toBe(1715679000)
    expect(synthesize(int, none, 0, [], 'exp_year')).toBe(2030)
    expect(synthesize(int, none, 0, [], 'exp_month')).toBe(12)
    expect(synthesize(int, none, 0, [], 'start_date')).toBe(1715679000)
  })

  it('keeps an error to its required fields, spec values and the usual error fields', async () => {
    const { synthesize } = await loaded()
    const resource = {
      type: 'object',
      properties: Object.fromEntries(['id', 'a', 'b', 'c', 'd'].map((k) => [k, string])),
    }
    const error = {
      type: 'object',
      required: ['type'],
      properties: {
        type: { type: 'string', enum: ['card_error'] },
        message: string,
        charge: string,
        payment_intent: resource,
      },
    }
    expect(Object.keys(synthesize(error, none, 0, [], '', 402) as object)).toEqual([
      'type',
      'message',
    ])
    // a success keeps the plain optional field an error leaves out
    expect(Object.keys(synthesize(error, none, 0, [], '', 200) as object)).toEqual([
      'type',
      'message',
      'charge',
    ])
  })

  it('leaves out a deprecated property unless it is required', async () => {
    const { synthesize } = await loaded()
    const schema = {
      type: 'object',
      required: ['old'],
      properties: {
        old: { ...string, deprecated: true },
        older: { ...string, deprecated: true },
        current: string,
      },
    }
    expect(Object.keys(synthesize(schema, none) as object)).toEqual(['old', 'current'])
  })

  it('shows another resource embedded by value as null, or leaves it out, but keeps small value objects', async () => {
    const { synthesize } = await loaded()
    const resource = {
      type: 'object',
      properties: Object.fromEntries(['id', 'a', 'b', 'c', 'd'].map((k) => [k, string])),
    }
    const tag = { type: 'object', properties: { id: { type: 'integer' }, name: string } }
    const schema = {
      type: 'object',
      required: ['owner'],
      properties: {
        owner: resource,
        discount: { ...resource, nullable: true },
        subscriptions: {
          type: 'object',
          properties: { object: string, data: { type: 'array', items: resource } },
        },
        sources: { type: 'array', items: resource },
        category: tag,
        customer: { anyOf: [string, resource] },
      },
    }
    const out = synthesize(schema, none, 0, [], '', 200) as Record<string, unknown>
    expect(Object.keys(out)).toEqual(['owner', 'discount', 'category', 'customer'])
    expect(out.discount).toBeNull()
    expect(typeof out.customer).toBe('string')
    // a request or an error is not a response to embed anything in
    expect(Object.keys(synthesize(schema, none) as object)).toContain('subscriptions')
  })

  it('shows a spec response example only when it satisfies the schema', async () => {
    const { conforms } = await loaded()
    const schema = {
      type: 'object',
      required: ['login'],
      properties: { login: string, reason: { type: ['string', 'null'] } },
    }
    expect(conforms(schema, { login: 'a', reason: null }, none)).toBe(true)
    expect(conforms(schema, { reason: 'x' }, none)).toBe(false)
    expect(conforms(schema, { login: 1 }, none)).toBe(false)
    // checked against the first branch of its own kind, as the viewer does
    const union = {
      oneOf: [
        { type: 'object', required: ['a'] },
        { type: 'object', required: ['b'] },
      ],
    }
    expect(conforms(union, { b: 1 }, none)).toBe(false)
    expect(conforms(union, { a: 1 }, none)).toBe(true)
  })

  it('keeps a null in a nullable enum written as a type list', async () => {
    const { toJsonSchema } = await loaded()
    const json = toJsonSchema({ type: ['string', 'null'], enum: ['a', 'b'] }, '#/') as any
    expect(JSON.stringify(json)).toContain('null')
  })

  it('does not invent a type for a field named for one', async () => {
    const { synthesize } = await loaded()
    expect(synthesize(string, none, 0, [], 'pet_type')).toBe('Example pet type')
    expect(synthesize(string, none, 0, [], 'org')).toBe('octo-org')
    expect(synthesize(string, none, 0, [], 'master_branch')).toBe('main')
  })
})
