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

describe('init and TypeScript', () => {
  it('adds typescript and a tsconfig that checks requests, flows, scripts and the config', async () => {
    await initCommand(dir, { agents: false })
    expect((await pkgOf()).devDependencies.typescript).toMatch(/^\d+\.\d+\.\d+$/)
    const tsconfig = JSON.parse(await readFile(join(dir, 'tsconfig.json'), 'utf8'))
    expect(tsconfig.include).toEqual([
      'requests',
      'sequences',
      'scripts',
      '.specbook/*.ts',
      '.generated/*/index.ts',
    ])
    expect(tsconfig.compilerOptions).toMatchObject({
      moduleResolution: 'Bundler',
      noEmit: true,
      types: [],
    })
  })

  it('never touches a tsconfig the project has, and says what it needs', async () => {
    const mine = '{ "compilerOptions": { "jsx": "preserve" } }\n'
    await writeFile(join(dir, 'tsconfig.json'), mine)
    await initCommand(dir, { agents: false })
    expect(await readFile(join(dir, 'tsconfig.json'), 'utf8')).toBe(mine)
    const said = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(' '))
      .join('\n')
    expect(said).toContain('tsconfig.json already exists and was not changed')
    expect(said).toContain('.specbook/*.ts')
  })

  it('leaves a typescript the project already has alone', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', devDependencies: { typescript: '^5.4.0' } }),
    )
    await initCommand(dir, { agents: false })
    expect((await pkgOf()).devDependencies.typescript).toBe('^5.4.0')
  })

  it('does not change what it wrote when run again', async () => {
    await initCommand(dir, { agents: false })
    const first = await readFile(join(dir, 'tsconfig.json'), 'utf8')
    await initCommand(dir, { agents: false })
    expect(await readFile(join(dir, 'tsconfig.json'), 'utf8')).toBe(first)
  })
})
