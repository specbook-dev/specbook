import { cp, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { addCommand } from '../src/commands/add'
import { generateServices } from '../src/commands/ensure'
import { fetchSpec, readSources, refreshCommand } from '../src/commands/spec-source'
import { createLoader } from '../src/load'
import { loadProject } from '../src/project'

const example = resolve(__dirname, '../../../apps/example')

let server: Server
let base: string
let petstore: string
/** what the server answers for each path */
const served = new Map<string, string>()

beforeAll(async () => {
  petstore = await readFile(join(example, 'openapi/petstore.json'), 'utf8')
  served.set('/pets.json', petstore)
  served.set('/not-a-spec.json', '{"hello":"world"}')
  server = createServer((rq, res) => {
    const body = served.get(rq.url ?? '')
    res.statusCode = body === undefined ? 404 : 200
    res.end(body ?? 'nope')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'sb-source-'))
  await mkdir(join(dir, '.specbook'), { recursive: true })
  await writeFile(
    join(dir, '.specbook/specbook.config.ts'),
    `import { defineConfig } from '@specbook/core'
export default defineConfig({
  project: 'tmp',
  services: {
  },
})
`,
  )
  await symlink(join(example, 'node_modules'), join(dir, 'node_modules'))
  return dir
}

/** The config is cached by the loader that read it: after an edit, read it with a new one. */
async function reload(dir: string) {
  const loader = await createLoader(dir)
  return { loader, project: await loadProject(dir, loader) }
}

async function withProject<T>(
  f: (
    dir: string,
    p: Awaited<ReturnType<typeof loadProject>>,
    l: Awaited<ReturnType<typeof createLoader>>,
  ) => Promise<T>,
) {
  const dir = await project()
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir)
  const loader = await createLoader(dir)
  try {
    return await f(dir, await loadProject(dir, loader), loader)
  } finally {
    await loader.close()
    log.mockRestore()
    err.mockRestore()
    cwd.mockRestore()
  }
}

describe('specbook add, from an address', () => {
  it('downloads the document into openapi/, records where it came from, and generates it', async () => {
    await withProject(async (dir, p) => {
      await addCommand(p, 'pets', `${base}/pets.json`)
      expect(await readFile(join(dir, 'openapi/pets.json'), 'utf8')).toBe(petstore)
      const sources = await readSources(join(dir, 'openapi'))
      expect(sources['pets.json']).toMatchObject({
        url: `${base}/pets.json`,
        bytes: petstore.length,
      })
      expect(sources['pets.json']?.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(await readFile(join(dir, '.specbook/specbook.config.ts'), 'utf8')).toContain(
        "spec: './openapi/pets.json'",
      )
      expect(await readdir(join(dir, '.generated/pets'))).toContain('manifest.json')
    })
  }, 60_000)

  it('refuses a document that is not OpenAPI, an address that fails, and a name already taken by another', async () => {
    await withProject(async (dir, p) => {
      await expect(addCommand(p, 'bad', `${base}/not-a-spec.json`)).rejects.toThrow(
        'not an OpenAPI document',
      )
      expect(await readdir(join(dir, 'openapi'))).toEqual([])
      await expect(addCommand(p, 'gone', `${base}/missing.json`)).rejects.toThrow('404')
      await addCommand(p, 'pets', `${base}/pets.json`)
      served.set('/other.json', petstore.replace('Swagger Petstore', 'Another Store'))
      await expect(fetchSpec(p, 'pets', `${base}/other.json`)).rejects.toThrow(
        'already exists and differs',
      )
    })
  }, 60_000)
})

describe('specbook add --refresh', () => {
  it('says what is unchanged, updates what changed and regenerates it, and leaves a file-only service alone', async () => {
    await withProject(async (dir, p) => {
      await addCommand(p, 'pets', `${base}/pets.json`)
      await cp(join(example, 'openapi/petstore.json'), join(dir, 'openapi/local.json'))
      const second = await reload(dir)
      await addCommand(second.project, 'local', './openapi/local.json')
      await second.loader.close()
      const { loader, project: again } = await reload(dir)
      try {
        const said: string[] = []
        const log = vi
          .spyOn(console, 'log')
          .mockImplementation((...a) => void said.push(a.join(' ')))
        expect(await refreshCommand(again, loader, [])).toBe(0)
        expect(said.join('\n')).toContain('pets: unchanged')
        expect(said.join('\n')).toContain('local: no recorded source')

        const before = (await readSources(join(dir, 'openapi')))['pets.json']?.sha256
        served.set('/pets.json', petstore.replace('Swagger Petstore', 'Renamed Store'))
        said.length = 0
        expect(await refreshCommand(again, loader, ['pets'])).toBe(0)
        log.mockRestore()
        expect(said.join('\n')).toMatch(/pets: updated, sha256 [0-9a-f]{12} → [0-9a-f]{12}/)
        const after = (await readSources(join(dir, 'openapi')))['pets.json']?.sha256
        expect(after).not.toBe(before)
        expect(await readFile(join(dir, 'openapi/pets.json'), 'utf8')).toContain('Renamed Store')
        served.set('/pets.json', petstore)

        expect(await refreshCommand(again, loader, ['nothing'])).toBe(3)
      } finally {
        await loader.close()
      }
    })
  }, 90_000)
})

describe('a compressed document', () => {
  it('is read as it is, with no flag', async () => {
    await withProject(async (dir, p) => {
      await mkdir(join(dir, 'openapi'), { recursive: true })
      await writeFile(join(dir, 'openapi/zipped.json.gz'), gzipSync(petstore))
      await addCommand(p, 'zipped', './openapi/zipped.json.gz')
      expect(await readFile(join(dir, '.specbook/specbook.config.ts'), 'utf8')).toContain(
        "spec: './openapi/zipped.json.gz'",
      )
      expect(await readdir(join(dir, '.generated/zipped'))).toContain('manifest.json')
      // and later generation reads it the same way
      const { loader, project: again } = await reload(dir)
      try {
        await generateServices(again, loader, ['zipped'], () => {})
      } finally {
        await loader.close()
      }
    })
  }, 60_000)
})
