import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateData, openSpec, parseSpecText } from '../src/browser'
import { generate } from '../src/generate'

const fixture = (name: string) => resolve(__dirname, 'fixtures', name)
const SOURCES = /^(types\.ts|index\.ts|operations\/.*\.ts|tags\/.*\.ts)$/

describe.each([
  ['petstore3', 'petstore3.json'],
  ['petstore2 (Swagger 2)', 'petstore2.json'],
])('the browser generator matches the CLI: %s', (_name, file) => {
  it('writes the same data files, the same manifest, and none of the sources', async () => {
    const path = fixture(file)
    const full = await generate({ spec: path, service: 'svc' })
    const { doc } = await openSpec(await readFile(path, 'utf8'))
    const data = generateData(doc, { service: 'svc' })

    const fullByPath = new Map(full.files.map((f) => [f.path, f.content]))
    const dataByPath = new Map(data.files.map((f) => [f.path, f.content]))

    // exactly the TypeScript sources are left out
    const left = [...fullByPath.keys()].filter((p) => !dataByPath.has(p))
    expect(left.length).toBeGreaterThan(0)
    // (and opmeta.json, which a run on disk reads and the browser has no use for)
    expect(left.every((p) => SOURCES.test(p) || p === 'opmeta.json')).toBe(true)
    // and nothing extra appears
    expect([...dataByPath.keys()].every((p) => fullByPath.has(p))).toBe(true)
    // every data file is byte-identical
    for (const [p, content] of dataByPath) expect(content, p).toBe(fullByPath.get(p))
    // the operation list is the same
    expect(data.operations).toEqual(full.operations)
  })

  it('describes each operation as data, so no generated module is needed', async () => {
    const { doc } = await openSpec(await readFile(fixture(file), 'utf8'))
    const data = generateData(doc, { service: 'svc' })
    expect(Object.keys(data.metas).sort()).toEqual(data.operations.map((o) => o.id).sort())
    for (const o of data.operations) {
      const m = data.metas[o.id]
      expect(m).toMatchObject({ service: 'svc', id: o.id, method: o.method, path: o.path })
    }
  })
})

describe('parsing and conversion', () => {
  it('reads YAML as well as JSON, with or without a byte order mark', () => {
    const yaml = 'openapi: 3.0.3\ninfo:\n  title: T\n  version: "1"\npaths: {}\n'
    expect(parseSpecText(yaml).info.title).toBe('T')
    expect(parseSpecText(`﻿${JSON.stringify({ openapi: '3.0.0', paths: {} })}`).openapi).toBe(
      '3.0.0',
    )
  })

  it('converts Swagger 2 to the same document the CLI path produces', async () => {
    const text = await readFile(fixture('petstore2.json'), 'utf8')
    const { doc, converted } = await openSpec(text)
    expect(converted).toBe(true)
    expect(doc.openapi).toMatch(/^3\./)
    expect(Object.keys(doc.paths).length).toBeGreaterThan(5)
  })

  it('says so when it is not a spec, and when references point elsewhere', async () => {
    await expect(openSpec('{"hello": "world"}')).rejects.toThrow(/not an OpenAPI 3 or Swagger 2/)
    await expect(openSpec('just some text')).rejects.toThrow()
    const withExternal = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'x', version: '1' },
      paths: { '/a': { get: { responses: { '200': { $ref: 'other.json#/Ok' } } } } },
    })
    const { warnings } = await openSpec(withExternal)
    expect(warnings.join(' ')).toMatch(/other\.json/)
  })
})
