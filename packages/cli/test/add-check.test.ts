import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { addCommand } from '../src/commands/add'
import { checkCommand } from '../src/commands/check'
import { createLoader } from '../src/load'
import { loadProject } from '../src/project'

const example = resolve(__dirname, '../../../apps/example')

async function tempProject() {
  const dir = await mkdtemp(join(tmpdir(), 'sb-proj-'))
  await cp(example, dir, {
    recursive: true,
    filter: (src) =>
      !src.includes('node_modules') &&
      !src.includes('.generated') &&
      !src.endsWith('tsconfig.json') &&
      !/openapi\/(stripe|github|countries)\.json$/.test(src) &&
      !/(requests\/(stripe|github|countries)|sequences\/(stripe|github)[^/]*)/.test(src),
  })
  // Only Petstore: the large Stripe/GitHub specs are fetched separately and not needed here.
  await writeFile(
    join(dir, '.specbook/specbook.config.ts'),
    `import { defineConfig } from '@specbook/core'
export default defineConfig({
  project: 'tmp',
  services: {
    petstore: { spec: './openapi/petstore.json', baseUrl: { live: 'https://petstore3.swagger.io/api/v3' } },
  },
})
`,
  )
  await symlink(join(example, 'node_modules'), join(dir, 'node_modules'))
  return dir
}

describe('add / check', () => {
  it('add registers the service in the config, generates it, and check then passes', async () => {
    const dir = await tempProject()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    const loader = await createLoader(dir)
    try {
      const project = await loadProject(dir, loader)
      await addCommand(project, 'pets2', './openapi/petstore.json', 'https://example.test')
      const cfg = await readFile(join(dir, '.specbook/specbook.config.ts'), 'utf8')
      expect(cfg).toContain("pets2: {\n      spec: './openapi/petstore.json'")
      await expect(addCommand(project, 'petstore', './openapi/petstore.json')).rejects.toThrow(
        /already exists/,
      )

      // regenerate for the original service too, then everything should be in sync
      const { generateToDisk } = await import('@specbook/codegen')
      await generateToDisk({
        spec: join(dir, 'openapi/petstore.json'),
        service: 'petstore',
        outDir: join(dir, '.generated'),
      })
      const reloaded = await createLoader(dir)
      try {
        const p2 = await loadProject(dir, reloaded)
        expect(await checkCommand(p2, reloaded)).toBe(0)

        // drift only matters for generated code that is committed, so track it before tampering
        execFileSync('git', ['init', '-q'], { cwd: dir })
        execFileSync('git', ['add', '-f', '.generated'], { cwd: dir })
        await writeFile(join(dir, '.generated/petstore/index.ts'), '// edited\n')
        expect(await checkCommand(p2, reloaded)).toBe(1)
      } finally {
        await reloaded.close()
      }
    } finally {
      await loader.close()
      log.mockRestore()
      cwd.mockRestore()
    }
  }, 60_000)
})
