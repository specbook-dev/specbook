import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateCommand } from '../src/commands/generate'
import type { Loader } from '../src/load'
import type { Project } from '../src/project'

const loader: Loader = { import: async () => ({}) as never, close: async () => {} }

async function emptyProject(): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), 'sb-generate-'))
  return {
    root,
    configFile: join(root, '.specbook/specbook.config.ts'),
    config: { project: 't', services: {} },
  }
}

describe('specbook generate in a project with no services yet', () => {
  afterEach(() => vi.restoreAllMocks())

  it('succeeds and says how to add one, so `npm install` right after `init` works', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(generateCommand(await emptyProject(), loader)).resolves.toBeUndefined()
    expect(log.mock.calls.join('\n')).toContain('specbook add <service>')
  })

  it('still fails for a service that was asked for by name and is not there', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(generateCommand(await emptyProject(), loader, ['petstore'])).rejects.toThrow(
      'No matching services in config',
    )
  })
})
