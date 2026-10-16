import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stripAnsi } from '@specbook/core'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { generateCommand } from '../src/commands/generate'
import { testCommand } from '../src/commands/test'
import { createLoader } from '../src/load'
import { loadProject } from '../src/project'

const root = resolve(__dirname, '../../../apps/example')

describe('example project (Petstore, mock env)', () => {
  it('generates, then runs every request and sequence green', async () => {
    const written: string[] = []
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    const loader = await createLoader(root)
    afterAll(() => loader.close())
    const project = await loadProject(root, loader)
    await generateCommand(project, loader)
    const meta = JSON.parse(await readFile(join(root, '.generated/specbook.json'), 'utf8'))
    expect(meta.sequences['adopt-pet'].title).toBe('Adopt a pet')
    expect(meta.services.petstore.operations.AddPet.method).toBe('POST')
    const code = await testCommand(project, loader, {
      patterns: ['sequences/*.seq.ts', 'requests/**/*.req.ts'],
      env: 'mock',
      params: {},
      vars: {},
      reporters: [],
      tags: [],
    })
    // a CI log gets color, which is not what is being compared
    const text = stripAnsi(written.join(''))
    out.mockRestore()
    expect(text).toContain('✓ Adopt a pet ›')
    expect(text).toMatch(/Flows\s+\d+ passed/)
    expect(code).toBe(0)
  }, 30_000)

  it('exits 2 when a live run lacks secrets', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    Reflect.deleteProperty(process.env, 'PETSTORE_API_KEY')
    const loader = await createLoader(root)
    const project = await loadProject(root, loader)
    const code = await testCommand(project, loader, {
      patterns: ['sequences/*.seq.ts'],
      env: 'live',
      params: {},
      vars: {},
      reporters: [],
      tags: [],
    })
    await loader.close()
    err.mockRestore()
    expect(code).toBe(2)
  }, 30_000)

  it('exits 3 and lists the environments when --env names one the project does not have', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const loader = await createLoader(root)
    const project = await loadProject(root, loader)
    const code = await testCommand(project, loader, {
      patterns: ['sequences/*.seq.ts'],
      env: 'nowhere',
      params: {},
      vars: {},
      reporters: [],
      tags: [],
    })
    await loader.close()
    const said = err.mock.calls.map((c) => c.join(' ')).join('\n')
    err.mockRestore()
    expect(code).toBe(3)
    expect(said).toContain('Unknown environment "nowhere". Known: mock, live')
  }, 30_000)
})
