import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { handleProxy, safeProjectPath, scanProject } from '../src'
import { requestsDirFor } from '../src/files'
import { parseSequenceMeta } from '../src/sequences'

describe('safeProjectPath', () => {
  const root = '/proj'
  it('allows ts/json inside the project', () => {
    expect(safeProjectPath(root, 'requests/a.req.ts')).toBe('/proj/requests/a.req.ts')
    expect(safeProjectPath(root, 'requests/pet.json')).toBe('/proj/requests/pet.json')
  })
  it('blocks traversal, absolute paths, generated code, node_modules, secrets and other extensions', () => {
    for (const p of [
      '../etc/passwd.ts',
      '/etc/passwd.ts',
      '.generated/x/index.ts',
      'node_modules/a/index.ts',
      '.specbook/secrets.local.env',
      'script.sh',
      'a/../../x.ts',
      '',
    ]) {
      expect(safeProjectPath(root, p), p).toBeUndefined()
    }
  })
})

describe('scanProject', () => {
  it('finds requests, sequences and sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-scan-'))
    await mkdir(join(dir, 'requests'), { recursive: true })
    await mkdir(join(dir, 'node_modules/x'), { recursive: true })
    await writeFile(join(dir, 'requests/a.req.ts'), '')
    await writeFile(join(dir, 'requests/b.seq.ts'), '')
    await writeFile(join(dir, 'requests/body.json'), '{}')
    await writeFile(join(dir, 'node_modules/x/c.req.ts'), '')
    const r = await scanProject(dir)
    expect(r.requests).toEqual(['requests/a.req.ts'])
    expect(r.sequences).toEqual(['requests/b.seq.ts'])
    expect(r.sources).toEqual(['requests/a.req.ts', 'requests/b.seq.ts', 'requests/body.json'])
  })
})

describe('proxy', () => {
  let upstreamSeen: { url?: string; headers?: Record<string, unknown>; body?: string } = {}
  const upstream = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => {
      b += c
    })
    req.on('end', () => {
      upstreamSeen = { url: req.url, headers: req.headers, body: b }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
  })
  const memory: Record<string, Record<string, string>> = {}
  const proxy = createServer((req, res) => {
    handleProxy(req, res, {
      getConfig: async () => ({
        services: {
          svc: {
            baseUrl: { live: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1` },
          },
        },
        secretNames: { KEY: {}, FILE_ONLY: {} },
      }),
      readSecrets: async (env) =>
        env === 'staging' ? { FILE_ONLY: 'from-staging-file' } : { FILE_ONLY: 'from-file' },
      env: { KEY: 'sk_real_123' },
      memory,
    }).then((handled) => {
      if (!handled) res.end('not handled')
    })
  })
  const listening = Promise.all([
    new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)),
  ])
  afterAll(() => {
    upstream.close()
    proxy.close()
  })
  const base = () => `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/__specbook/proxy`

  it('substitutes secrets server-side from env and the local file, and forwards to the allowlisted base', async () => {
    await listening
    const r = await fetch(`${base()}/live/svc/pets?k={{secrets.KEY}}`, {
      method: 'POST',
      headers: { 'x-api-key': '{{secrets.KEY}}', 'content-type': 'application/json' },
      body: JSON.stringify({ f: '{{secrets.FILE_ONLY}}' }),
    })
    expect(await r.json()).toEqual({ ok: true })
    expect(upstreamSeen.url).toBe('/v1/pets?k=sk_real_123')
    expect(upstreamSeen.headers?.['x-api-key']).toBe('sk_real_123')
    expect(upstreamSeen.body).toBe('{"f":"from-file"}')
  })
  it('prefers a credential typed into the UI over the environment', async () => {
    await listening
    memory['*'] = { KEY: 'sk_from_ui' }
    await fetch(`${base()}/live/svc/pets`, { headers: { 'x-api-key': '{{secrets.KEY}}' } })
    expect(upstreamSeen.headers?.['x-api-key']).toBe('sk_from_ui')
    // a value saved for one environment wins there and is ignored elsewhere
    memory.live = { KEY: 'sk_live_only' }
    await fetch(`${base()}/live/svc/pets`, { headers: { 'x-api-key': '{{secrets.KEY}}' } })
    expect(upstreamSeen.headers?.['x-api-key']).toBe('sk_live_only')
    delete memory['*']
    delete memory.live
  })
  it('forwards a file upload byte for byte and still fills a secret placed in a binary body', async () => {
    await listening
    const seen: { bytes?: Buffer } = {}
    const got = () => seen.bytes
    const capture = () =>
      upstream.once('request', (req) => {
        const parts: Buffer[] = []
        req.on('data', (c: Buffer) => parts.push(c))
        req.on('end', () => {
          seen.bytes = Buffer.concat(parts)
        })
      })
    capture()
    // not valid UTF-8: a PNG signature, high bytes and a lone continuation byte
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0xa0])
    const r = await fetch(`${base()}/live/svc/pet/7/uploadImage`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: png,
    })
    expect(r.status).toBe(200)
    expect(got()?.toString('hex')).toBe(png.toString('hex'))
    expect(upstreamSeen.headers?.['content-type']).toBe('application/octet-stream')

    // a placeholder inside bytes is replaced, the bytes around it are not touched
    const framed = Buffer.concat([
      Buffer.from([0xff, 0x00]),
      Buffer.from('{{secrets.KEY}}'),
      Buffer.from([0x80, 0xfe]),
    ])
    seen.bytes = undefined
    capture()
    await fetch(`${base()}/live/svc/pet/7/uploadImage`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: framed,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(got()?.toString('hex')).toBe(
      Buffer.concat([
        Buffer.from([0xff, 0x00]),
        Buffer.from('sk_real_123'),
        Buffer.from([0x80, 0xfe]),
      ]).toString('hex'),
    )
  })
  it('forwards a multipart upload with its boundary and the file bytes intact', async () => {
    await listening
    const seen: { body?: Buffer } = {}
    const got = () => seen.body
    upstream.once('request', (req) => {
      const parts: Buffer[] = []
      req.on('data', (c: Buffer) => parts.push(c))
      req.on('end', () => {
        seen.body = Buffer.concat(parts)
      })
    })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0xa0])
    const form = new FormData()
    form.append('name', 'Rex')
    form.append('photo', new Blob([png], { type: 'image/png' }), 'rex.png')
    const r = await fetch(`${base()}/live/svc/pet/7/photo`, { method: 'POST', body: form })
    expect(r.status).toBe(200)
    await new Promise((res) => setTimeout(res, 20))
    const type = String(upstreamSeen.headers?.['content-type'])
    const boundary = /boundary=(.+)$/.exec(type)?.[1]
    expect(type).toMatch(/^multipart\/form-data; boundary=/)
    const body = got() as Buffer
    expect(body.includes(`--${boundary}`)).toBe(true)
    expect(body.includes(png)).toBe(true)
    expect(body.toString('latin1')).toContain('filename="rex.png"')
  })
  it('refuses a request a browser marks as coming from another site, and passes ordinary ones', async () => {
    await listening
    upstreamSeen = {}
    const cross = await fetch(`${base()}/live/svc/pets`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', 'x-api-key': '{{secrets.KEY}}' },
      body: '{}',
    })
    expect(cross.status).toBe(403)
    const foreign = await fetch(`${base()}/live/svc/pets`, {
      headers: { origin: 'https://evil.example' },
    })
    expect(foreign.status).toBe(403)
    // nothing reached the API, and no secret was looked up for it
    expect(upstreamSeen.url).toBeUndefined()
    const same = await fetch(`${base()}/live/svc/pets`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    expect(same.status).toBe(200)
  })
  it('rejects unknown services/envs and unresolved secrets', async () => {
    await listening
    expect((await fetch(`${base()}/live/nope/x`)).status).toBe(404)
    expect((await fetch(`${base()}/prod/svc/x`)).status).toBe(404)
    const r = await fetch(`${base()}/live/svc/x`, { headers: { a: '{{secrets.MISSING}}' } })
    expect(r.status).toBe(400)
  })
})

describe('examples and docs', () => {
  it('merges generated and project examples and lists their assets', async () => {
    const { scanExamples } = await import('../src/examples')
    const dir = await mkdtemp(join(tmpdir(), 'sb-ex-'))
    await mkdir(join(dir, '.generated/shop/examples/Upload'), { recursive: true })
    await mkdir(join(dir, 'requests/shop/Upload'), { recursive: true })
    await writeFile(join(dir, '.generated/shop/examples/Upload/default.example.json'), '{}')
    await writeFile(join(dir, '.generated/shop/examples/Upload/sample.txt'), 'x')
    await writeFile(join(dir, 'requests/shop/Upload/default.example.json'), '{"title":"mine"}')
    await writeFile(join(dir, 'requests/shop/Upload/vip.example.json'), '{}')
    await writeFile(join(dir, 'requests/shop/Upload/cat.png'), 'x')
    await mkdir(join(dir, 'requests/other/Nope'), { recursive: true })
    await writeFile(join(dir, 'requests/other/Nope/a.example.json'), '{}')

    const r = await scanExamples(dir, '.generated', new Set(['shop/Upload']))
    expect(r.examples['shop/Upload']?.map((e) => [e.name, e.source])).toEqual([
      ['default', 'project'],
      ['vip', 'project'],
    ])
    expect(Object.keys(r.examples)).toEqual(['shop/Upload'])
    expect(Object.keys(r.assets).sort()).toEqual([
      'shop/Upload@generated/sample.txt',
      'shop/Upload@project/cat.png',
    ])
  })

  it('compiles markdown pages that name an operation or sequence', async () => {
    const { scanDocs } = await import('../src/docs')
    const dir = await mkdtemp(join(tmpdir(), 'sb-docs-'))
    await writeFile(
      join(dir, 'add-pet.md'),
      '---\noperation: petstore/AddPet\ntitle: "Adding a pet"\n---\n# Hello\n\nSome *text*.',
    )
    await writeFile(join(dir, 'README.md'), '# Not a docs page')
    const pages = await scanDocs(dir)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ operation: 'petstore/AddPet', title: 'Adding a pet' })
    expect(pages[0]?.html).toContain('<h1>Hello</h1>')
    expect(pages[0]?.html).toContain('<em>text</em>')
  })

  it('attaches markdown by where it sits: beside a .seq.ts, a .req.ts, or in an operation folder', async () => {
    const { scanDocs, colocated } = await import('../src/docs')
    const dir = await mkdtemp(join(tmpdir(), 'sb-docs-'))
    await mkdir(join(dir, 'sequences'), { recursive: true })
    await mkdir(join(dir, 'requests/petstore/AddPet'), { recursive: true })
    await writeFile(join(dir, 'sequences/adopt.seq.md'), 'About adopting.')
    await writeFile(join(dir, 'requests/petstore/find.req.md'), 'About finding.')
    await writeFile(join(dir, 'requests/petstore/AddPet/README.md'), 'About adding.')
    await writeFile(join(dir, 'README.md'), '# project readme, not a page')
    const pages = await scanDocs(dir)
    const by = Object.fromEntries(pages.map((p) => [p.file, p]))
    expect(Object.keys(by).sort()).toEqual([
      'requests/petstore/AddPet/README.md',
      'requests/petstore/find.req.md',
      'sequences/adopt.seq.md',
    ])
    expect(by['sequences/adopt.seq.md']?.sequenceFile).toBe('sequences/adopt.seq.ts')
    expect(by['requests/petstore/find.req.md']?.requestFile).toBe('requests/petstore/find.req.ts')
    expect(by['requests/petstore/AddPet/README.md']?.operation).toBe('petstore/AddPet')
    expect(colocated('docs/notes.md')).toBeUndefined()
    expect(colocated('requests/petstore/README.md')).toBeUndefined()
  })

  it('also takes flat pages: requests/<service>/docs/<Operation>.md, one folder per service', async () => {
    const { scanDocs, colocated } = await import('../src/docs')
    const dir = await mkdtemp(join(tmpdir(), 'sb-docs-'))
    await mkdir(join(dir, 'requests/petstore/docs'), { recursive: true })
    await mkdir(join(dir, 'requests/stripe/docs'), { recursive: true })
    await writeFile(
      join(dir, 'requests/petstore/docs/AddPet.md'),
      '---\ntitle: Adding\n---\nAbout adding.',
    )
    await writeFile(join(dir, 'requests/stripe/docs/AddPet.md'), 'A different service, same name.')
    await writeFile(join(dir, 'requests/petstore/docs/README.md'), '# index of the docs folder')
    const pages = await scanDocs(dir)
    const ops = Object.fromEntries(pages.map((p) => [p.file, p.operation]))
    expect(ops).toEqual({
      'requests/petstore/docs/AddPet.md': 'petstore/AddPet',
      'requests/stripe/docs/AddPet.md': 'stripe/AddPet',
    })
    expect(pages.find((p) => p.operation === 'petstore/AddPet')?.title).toBe('Adding')
    // `docs` is the flat folder, never an operation named "docs"
    expect(colocated('requests/petstore/docs/README.md')).toBeUndefined()
    expect(colocated('requests/petstore/docs/AddPet.md')).toEqual({ operation: 'petstore/AddPet' })
    // the older form keeps working
    expect(colocated('requests/petstore/AddPet/README.md')).toEqual({
      operation: 'petstore/AddPet',
    })
  })

  it('uses one page per operation when a folder page and a flat page both exist, and says so', async () => {
    const { scanDocs } = await import('../src/docs')
    const dir = await mkdtemp(join(tmpdir(), 'sb-docs-'))
    await mkdir(join(dir, 'requests/petstore/AddPet'), { recursive: true })
    await mkdir(join(dir, 'requests/petstore/docs'), { recursive: true })
    await writeFile(join(dir, 'requests/petstore/AddPet/README.md'), 'folder form')
    await writeFile(join(dir, 'requests/petstore/docs/AddPet.md'), 'flat form')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const pages = await scanDocs(dir)
      expect(pages.map((p) => p.file)).toEqual(['requests/petstore/AddPet/README.md'])
      expect(warn.mock.calls.flat().join(' ')).toContain('petstore/AddPet')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('parseSequenceMeta', () => {
  it('reads the literal header without importing the file', () => {
    const src = `import { c, sequence } from '@specbook/core'
export default sequence({
  id: 'adopt-pet', // the id
  title: "Adopt a pet",
  description: 'Find \\'em, order it.',
  tags: ['petstore', 'smoke'],
  params: { quantity: c.number({ default: 1, id: 'nope', title: 'not this' }) },
}).step('x', y)`
    expect(parseSequenceMeta(src)).toEqual({
      id: 'adopt-pet',
      title: 'Adopt a pet',
      description: "Find 'em, order it.",
      tags: ['petstore', 'smoke'],
    })
  })

  it('gives up on computed values so the file is imported instead', () => {
    expect(parseSequenceMeta(`sequence({ id: 'a', title: \`T \${x}\` })`)).toBeUndefined()
    expect(parseSequenceMeta("sequence({ id: 'a', title: 'A' + 'B' })")).toBeUndefined()
    expect(parseSequenceMeta("sequence({ id, title: 'A' })")).toBeUndefined()
    expect(parseSequenceMeta("sequence({ id: 'a', title: 'A', tags: [t] })")).toBeUndefined()
    expect(parseSequenceMeta('export const x = 1')).toBeUndefined()
  })

  it('treats description and tags as optional', () => {
    expect(parseSequenceMeta("sequence({ id: 'a', title: 'A' })")).toEqual({ id: 'a', title: 'A' })
  })

  it('reads the flow group', () => {
    expect(parseSequenceMeta("sequence({ id: 'a', title: 'A', group: 'Billing' })")).toEqual({
      id: 'a',
      title: 'A',
      group: 'Billing',
    })
  })
})

describe('environment files', () => {
  it('edits one key and leaves comments and other keys alone', async () => {
    const { setDotenvKey } = await import('../src/environments')
    const before = '# keys\nA=1\nexport B=two words\n\nC=3\n'
    expect(setDotenvKey(before, 'B', 'x y')).toBe('# keys\nA=1\nB="x y"\n\nC=3\n')
    expect(setDotenvKey(before, 'D', 'new')).toBe('# keys\nA=1\nexport B=two words\n\nC=3\nD=new\n')
    expect(setDotenvKey(before, 'A', undefined)).toBe('# keys\nexport B=two words\n\nC=3\n')
    expect(setDotenvKey('', 'K', 'v')).toBe('K=v\n')
    expect(() => setDotenvKey('', 'K', 'a\nb')).toThrow(/single line/)
  })

  it('reads an environment and creates a folder that gitignores secrets', async () => {
    const { readEnvironment, ensureEnvironmentsDir, writeEnvKey, secretsFileFor, varsFile } =
      await import('../src/environments')
    const root = await mkdtemp(join(tmpdir(), 'sb-env-'))
    await ensureEnvironmentsDir(root)
    await writeEnvKey(varsFile(root, 'staging'), 'owner', 'acme')
    await writeEnvKey(secretsFileFor(root, 'staging'), 'KEY', 'sk_stage')
    await writeFile(join(root, '.specbook/secrets.local.env'), 'KEY=sk_shared\nOTHER=o\n')
    const e = await readEnvironment(root, 'staging')
    expect(e).toEqual({
      vars: { owner: 'acme' },
      secrets: { KEY: 'sk_stage' },
      shared: { KEY: 'sk_shared', OTHER: 'o' },
    })
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(root, '.specbook/environments/.gitignore'), 'utf8')).toContain(
      '*.secrets.env',
    )
    expect((await readEnvironment(root, '../etc')).vars).toEqual({})
  })
})

describe('requestsDirFor', () => {
  it('uses requests/, except in projects that already have an apis/ folder and no requests/', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'sb-rd-'))
    expect(requestsDirFor(fresh)).toBe('requests')
    const old = await mkdtemp(join(tmpdir(), 'sb-rd-'))
    await mkdir(join(old, 'apis'))
    expect(requestsDirFor(old)).toBe('apis')
    await mkdir(join(old, 'requests'))
    expect(requestsDirFor(old)).toBe('requests')
  })
})
