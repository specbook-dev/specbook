import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { addCommand } from '../src/commands/add'
import { checkCommand } from '../src/commands/check'
import { secretsCommand } from '../src/commands/secrets'
import { testCommand } from '../src/commands/test'
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
      // and the credentials the spec asks for: a secret named for the service, a profile, and the service uses it
      expect(cfg).toContain('secrets: { PETS2_API_KEY: {}, PETS2_PETSTORE_AUTH: {} },')
      // every way the spec accepts is a profile, the cheapest the default
      expect(cfg).toContain("auth: ['pets2', 'pets2-petstore-auth'],")
      expect(cfg).toContain("title: 'API key',")
      expect(cfg).toContain("scheme: 'api_key',")
      expect(cfg).toContain("apply: { headers: { api_key: '{{secrets.PETS2_API_KEY}}' } },")
      expect(cfg).toContain("'pets2-petstore-auth': {")
      expect(cfg).toContain("flow: 'implicit',")
      const said = log.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(said).toContain('2 ways to authenticate, the first is the default')
      expect(said).toContain('profile "pets2" sends PETS2_API_KEY')
      expect(said).toContain(
        'profile "pets2-petstore-auth" signs in with OAuth, or takes a pasted token in PETS2_PETSTORE_AUTH',
      )

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
      // the same spec added again gets secrets and a profile of its own, in the blocks that are there
      expect(multi).toContain(
        'secrets: { MULTI_API_KEY: {}, MULTI_PETSTORE_AUTH: {}, PETS2_API_KEY: {}, PETS2_PETSTORE_AUTH: {} },',
      )
      expect(multi).toContain("auth: ['multi', 'multi-petstore-auth'],")
      expect(multi.match(/^ {2}secrets:/gm)).toHaveLength(1)
      expect(multi.match(/^ {2}auth: \{/gm)).toHaveLength(1)
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

describe('check on auth profiles', () => {
  const checkWith = async (auth: string, services: string) => {
    const dir = await tempProject()
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')))
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    try {
      await writeFile(
        join(dir, '.specbook/specbook.config.ts'),
        `import { defineConfig } from '@specbook/core'
export default defineConfig({
  project: 'tmp',
  secrets: { KEY: {}, TOKEN: {}, ID: {}, SECRET: {} },
  auth: { ${auth} },
  services: { petstore: { spec: './openapi/petstore.json', baseUrl: { live: 'https://p.test' }, ${services} } },
})
`,
      )
      const loader = await createLoader(dir)
      try {
        const code = await checkCommand(await loadProject(dir, loader), loader)
        return { code, said: lines.join('\n') }
      } finally {
        await loader.close()
      }
    } finally {
      log.mockRestore()
      cwd.mockRestore()
    }
  }
  const key = "key: { scheme: 'api_key', apply: { headers: { api_key: '{{secrets.KEY}}' } } },"
  const oauth =
    "tok: { scheme: 'petstore_auth', apply: { headers: { authorization: 'Bearer {{secrets.TOKEN}}' } } },"

  it('is quiet when the profiles cover what the spec accepts', async () => {
    const r = await checkWith(`${key} ${oauth}`, "auth: ['key', 'tok']")
    expect(r.code).toBe(0)
    for (const text of ['auth lists', '[auth ', 'auth profiles']) expect(r.said).not.toContain(text)
  }, 60_000)

  it('errors on a listed profile the config does not have', async () => {
    const r = await checkWith(key, "auth: ['key', 'ghost']")
    expect(r.code).toBe(1)
    expect(r.said).toContain('[petstore] auth lists "ghost", which is not a profile in config.auth')
  }, 60_000)

  it('warns on a scheme the spec does not define, and on operations no listed profile accepts', async () => {
    const r = await checkWith(
      "other: { scheme: 'nope', apply: { headers: { a: '{{secrets.KEY}}' } } }, " + key,
      "auth: ['other', 'key']",
    )
    expect(r.said).toContain('[auth other] scheme "nope" is not a security scheme of "petstore"')
    // the seven pet operations take only petstore_auth
    expect(r.said).toContain(
      '7 operations accept none of its auth profiles (the spec wants petstore_auth)',
    )
  }, 60_000)

  it('errors on a client secret that is a value, and a client without a token address', async () => {
    const r = await checkWith(
      "c: { apply: {}, oauth: { tokenUrl: 'https://i.test/t', clientId: '{{secrets.ID}}', clientSecret: 'hunter2' } }, d: { apply: {}, oauth: { tokenUrl: '', clientId: '{{secrets.ID}}', clientSecret: '{{secrets.SECRET}}' } }",
      "auth: ['c']",
    )
    expect(r.code).toBe(1)
    expect(r.said).toContain(
      '[auth c] oauth.clientSecret must be a {{secrets.NAME}} placeholder, not a value',
    )
    expect(r.said).toContain('[auth d] oauth.tokenUrl is missing')
  }, 60_000)
})

describe('credentials that add wrote', () => {
  it('are named by `secrets`, run on the mock with no value, and are required on a real environment', async () => {
    const dir = await tempProject()
    const lines: string[] = []
    const errors: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')))
    const err = vi
      .spyOn(console, 'error')
      .mockImplementation((...a) => void errors.push(a.join(' ')))
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    const loader = await createLoader(dir)
    try {
      await addCommand(
        await loadProject(dir, loader),
        'pets2',
        './openapi/petstore.json',
        'https://example.test',
      )
      await mkdir(join(dir, 'requests/pets2'), { recursive: true })
      await writeFile(
        join(dir, 'requests/pets2/find.req.ts'),
        `import { FindPetsByStatus } from '#api/pets2'
export default FindPetsByStatus.request({ query: { status: 'available' } })
`,
      )
      const reloaded = await createLoader(dir)
      try {
        const project = await loadProject(dir, reloaded)
        lines.length = 0
        expect(await secretsCommand(project, 'live')).toBe(1)
        expect(lines.join('\n')).toContain('✗ PETS2_API_KEY')
        expect(lines.join('\n')).toContain('✗ PETS2_PETSTORE_AUTH')

        const o = {
          patterns: ['requests/pets2/find.req.ts'],
          inputs: {},
          vars: {},
          reporters: [],
          tags: [],
        }
        // the mock needs no value, whatever the scheme: the profile sent its credential, so the mock does not say 401
        expect(await testCommand(project, reloaded, { ...o, env: 'mock' })).toBe(0)
        // a real environment cannot run without it, and says which
        errors.length = 0
        expect(await testCommand(project, reloaded, { ...o, env: 'live' })).toBe(2)
        // this operation takes only the OAuth scheme, so it is that profile's secret the run asks for
        expect(errors.join('\n')).toContain('PETS2_PETSTORE_AUTH')
        expect(errors.join('\n')).not.toContain('PETS2_API_KEY')
      } finally {
        await reloaded.close()
      }
    } finally {
      await loader.close()
      log.mockRestore()
      err.mockRestore()
      out.mockRestore()
      cwd.mockRestore()
    }
  }, 60_000)
})
