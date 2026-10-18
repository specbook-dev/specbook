import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCommand } from '../src/commands/init'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'specbook-init-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

const pkgOf = async () => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))

describe('init and faker', () => {
  it('adds @faker-js/faker so generated values and {{faker.*}} always work', async () => {
    await initCommand(dir, { agents: false })
    expect((await pkgOf()).devDependencies['@faker-js/faker']).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('leaves a faker the project already has alone', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { '@faker-js/faker': '^8.0.0' } }),
    )
    await initCommand(dir, { agents: false })
    const pkg = await pkgOf()
    expect(pkg.dependencies['@faker-js/faker']).toBe('^8.0.0')
    expect(pkg.devDependencies['@faker-js/faker']).toBeUndefined()
  })
})
