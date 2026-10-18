import { Module } from 'node:module'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { generateCommand } from '../src/commands/generate'
import { buildCommand } from '../src/commands/ui'
import { createLoader } from '../src/load'
import { loadProject } from '../src/project'

vi.spyOn(console, 'log').mockImplementation(() => {})

const example = resolve(__dirname, '../../../apps/example')

describe('faker in a built portal', () => {
  it('ships faker and only the locales the config can reach, in the full and the minimal build', async () => {
    const loader = await createLoader(example)
    afterAll(() => loader.close())
    const project = await loadProject(example, loader)
    await generateCommand(project, loader)
    for (const minimal of [true, false]) {
      const out = await mkdtemp(join(tmpdir(), 'sb-faker-'))
      afterAll(() => rm(out, { recursive: true, force: true }))
      await buildCommand(project, out, { minimal })
      const assets = await readdir(join(out, 'assets'))
      const names = (re: RegExp) =>
        assets
          .map((f) => re.exec(f)?.[1])
          .filter(Boolean)
          .sort()
      // the config lists en, de and ja; each chain ends in base
      expect(names(/^([a-z]{2}(?:_[A-Z]+)?|base)-[\w-]{8}\.js$/), `minimal: ${minimal}`).toEqual([
        'base',
        'de',
        'en',
        'ja',
      ])
      expect(assets.some((f) => /^faker-/.test(f))).toBe(true)
    }
  })

  it('fails the build when a request uses faker and the project has none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-nofaker-'))
    afterAll(() => rm(dir, { recursive: true, force: true }))
    await mkdir(join(dir, '.specbook'), { recursive: true })
    await writeFile(
      join(dir, '.specbook/specbook.config.ts'),
      "export default { project: 'x', services: {} }\n",
    )
    await mkdir(join(dir, 'requests'), { recursive: true })
    await writeFile(
      join(dir, 'requests/a.req.ts'),
      "import { faker } from '@specbook/core/faker'\nexport const name = () => faker.person.fullName()\n",
    )
    await writeFile(join(dir, 'package.json'), '{"name":"x","type":"module"}')
    const loader = await createLoader(dir)
    afterAll(() => loader.close())
    const project = await loadProject(dir, loader)
    // pnpm puts the workspace's packages on NODE_PATH, which would let a bare project find faker
    vi.stubEnv('NODE_PATH', '')
    ;(Module as unknown as { _initPaths(): void })._initPaths()
    try {
      await expect(buildCommand(project, join(dir, 'dist'))).rejects.toThrow(
        /requests\/a\.req\.ts uses faker, but @faker-js\/faker is not installed/,
      )
    } finally {
      vi.unstubAllEnvs()
      ;(Module as unknown as { _initPaths(): void })._initPaths()
    }
  })
})
