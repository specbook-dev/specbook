import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { generateCommand } from '../src/commands/generate'
import { runCommand } from '../src/commands/run'
import { createLoader } from '../src/load'
import { loadProject } from '../src/project'

const root = resolve(__dirname, '../../../apps/example')

describe('example project (Petstore, mock env)', () => {
  it('generates, then runs every request and sequence green', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const loader = await createLoader(root)
    afterAll(() => loader.close())
    const project = await loadProject(root, loader)
    await generateCommand(project, loader)
    const meta = JSON.parse(await readFile(join(root, '.generated/specbook.json'), 'utf8'))
    expect(meta.sequences['adopt-pet'].title).toBe('Adopt a pet')
    expect(meta.services.petstore.operations.AddPet.method).toBe('POST')
    const code = await runCommand(project, loader, {
      patterns: ['sequences/*.seq.ts', 'requests/**/*.req.ts'],
      env: 'mock',
      params: {},
      vars: {},
      reporters: [],
      tags: [],
    })
    const out = log.mock.calls.map((c) => c.join(' ')).join('\n')
    log.mockRestore()
    expect(out).toContain('✓ Adopt a pet')
    expect(code).toBe(0)
  }, 30_000)

  it('exits 2 when a live run lacks secrets', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    Reflect.deleteProperty(process.env, 'PETSTORE_API_KEY')
    const loader = await createLoader(root)
    const project = await loadProject(root, loader)
    const code = await runCommand(project, loader, {
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
})
