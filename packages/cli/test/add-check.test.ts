import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
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
      !src.endsWith('openapi/sources.json') &&
      !/(requests\/(stripe|github|countries)|sequences\/(stripe|github)[^/]*)/.test(src),
  })
  // Only Petstore: the large Stripe and GitHub specs are not needed here.
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
      // the address is a variable; the config had no `vars`, so one is added
      expect(cfg).toContain("baseUrl: '{{pets2Url}}'")
      expect(cfg).toMatch(/vars: \{\n\s+pets2Url: 'https:\/\/example\.test',\n\s+\},/)

      // a spec with several servers: the first is the default, the others are environment files
      const spec = JSON.parse(await readFile(join(dir, 'openapi/petstore.json'), 'utf8'))
      spec.servers = [
        { url: 'https://prod.example.test/v1' },
        { url: 'https://staging.example.test/v1', description: 'Staging' },
        { url: 'http://localhost:8080/v1', description: 'Local' },
      ]
      await writeFile(join(dir, 'openapi/multi.json'), JSON.stringify(spec))
      await mkdir(join(dir, '.specbook/environments'), { recursive: true })
      await writeFile(
        join(dir, '.specbook/environments/staging.env'),
        'multiUrl=https://kept.example.test\nOTHER=1\n',
      )
      await addCommand(project, 'multi', './openapi/multi.json')
      const multi = await readFile(join(dir, '.specbook/specbook.config.ts'), 'utf8')
      expect(multi).toMatch(/multiUrl: 'https:\/\/prod\.example\.test\/v1'/)
      expect(multi).toContain("baseUrl: '{{multiUrl}}'")
      // an existing value in an environment file is not overwritten; a new environment gets its file
      expect(await readFile(join(dir, '.specbook/environments/staging.env'), 'utf8')).toBe(
        'multiUrl=https://kept.example.test\nOTHER=1\n',
      )
      expect(await readFile(join(dir, '.specbook/environments/local.env'), 'utf8')).toContain(
        'multiUrl=http://localhost:8080/v1',
      )
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

  it('counts `pets[0].name` as a use of `pets`: quiet when the request supplies it, a warning naming it when nothing does', async () => {
    const dir = await tempProject()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    try {
      const { generateToDisk } = await import('@specbook/codegen')
      await generateToDisk({
        spec: join(dir, 'openapi/petstore.json'),
        service: 'petstore',
        outDir: join(dir, '.generated'),
      })
      await writeFile(
        join(dir, 'requests/petstore/brackets.req.ts'),
        `import { AddPet } from '#api/petstore'
export default AddPet.request({
  init: { pets: [{ name: 'Rex' }] },
  data: { name: '{{pets[0].name}}', photoUrls: ['{{urls[0]}}'] },
})
`,
      )
      const loader = await createLoader(dir)
      try {
        const project = await loadProject(dir, loader)
        await checkCommand(project, loader)
        const said = log.mock.calls.map((c) => c.join(' ')).join('\n')
        expect(said).toContain('"{{urls[0]}}" has no init value or config var')
        expect(said).not.toContain('"{{pets[0].name}}"')
      } finally {
        await loader.close()
      }
    } finally {
      log.mockRestore()
      cwd.mockRestore()
    }
  }, 60_000)
})
