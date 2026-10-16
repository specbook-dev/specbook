import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generateToDisk } from '@specbook/codegen'
import { describe, expect, it, vi } from 'vitest'
import { checkCommand } from '../src/commands/check'
import { createLoader } from '../src/load'
import { importedOperations, usedMetadata, usedOperationKeys, usedOperations } from '../src/ops'
import { loadProject } from '../src/project'

const example = resolve(__dirname, '../../../apps/example')

describe('importedOperations', () => {
  const scan = (text: string) => importedOperations('x.req.ts', text, '#api')

  it('reads named, aliased, multi-line and namespace imports', () => {
    const got = scan(`import { A, B as Bee, type C } from '#api/petstore'
import * as gh from '#api/github'
import {
  E,
  F,
} from '#api/stripe'
import { X } from '../x'
export default A.request({})`)
    expect(got).toEqual([
      { service: 'petstore', names: ['A', 'B'], all: false },
      { service: 'github', names: [], all: true },
      { service: 'stripe', names: ['E', 'F'], all: false },
    ])
  })

  it('ignores type-only imports and other modules', () => {
    expect(scan(`import type { D } from '#api/petstore'\nimport { z } from 'zod'`)).toEqual([])
  })

  it('merges repeated imports of one service and honours a prefix', () => {
    expect(scan(`import { A } from '#api/p'\nimport { B } from '#api/p'`)).toEqual([
      { service: 'p', names: ['A', 'B'], all: false },
    ])
    expect(importedOperations('x.ts', `import { A } from '@gen/p'`, '@gen')).toEqual([
      { service: 'p', names: ['A'], all: false },
    ])
  })
})

async function project(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'sb-ops-'))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  await symlink(join(example, 'node_modules'), join(dir, 'node_modules'))
  return dir
}

const config = (extra = '') => `import { defineConfig } from '@specbook/core'
export default defineConfig({
  project: 'tmp',
  vars: { petUrl: 'https://petstore3.swagger.io/api/v3' },
  services: { petstore: { spec: './openapi/petstore.json', baseUrl: '{{petUrl}}' } },${extra}
})
`

const request = (op: string) => `import { ${op} } from '#api/petstore'
export default ${op}.request({ name: 'x', query: { status: 'available' } })
`

const generated = async (dir: string) => {
  await generateToDisk({
    spec: join(example, 'openapi/petstore.json'),
    service: 'petstore',
    outDir: join(dir, '.generated'),
  })
}

describe('the operations your requests use', () => {
  it('are the imported ones, with what generation recorded about each', async () => {
    const dir = await project({
      '.specbook/specbook.config.ts': config(),
      'requests/find.req.ts': request('FindPetsByStatus'),
      'sequences/s.seq.ts': `import find from '../requests/find.req'\nexport default find`,
    })
    await generated(dir)
    const p = { root: dir, config: { services: { petstore: {} } } as never }
    const used = await usedMetadata(p, join(dir, '.generated'))
    expect(Object.keys(used.services.petstore ?? {})).toEqual(['FindPetsByStatus'])
    expect(used.services.petstore?.FindPetsByStatus).toMatchObject({
      service: 'petstore',
      id: 'FindPetsByStatus',
      method: 'GET',
      path: '/pet/findByStatus',
    })
    expect(used.missing).toEqual([])
    expect([...(await usedOperationKeys(p, join(dir, '.generated')))]).toEqual([
      'petstore/FindPetsByStatus',
    ])
  })

  it('count the config as a place that imports them, and a namespace import as every operation', async () => {
    const dir = await project({
      '.specbook/specbook.config.ts': `import { Login } from '#api/petstore'\n${config()}`,
      'requests/all.req.ts': `import * as api from '#api/petstore'\nexport default api.GetPetById.request({})`,
    })
    const used = await usedOperations({
      root: dir,
      config: { services: { petstore: {} } } as never,
    })
    expect(used.named.get('petstore')).toEqual(new Set(['Login']))
    expect(used.whole.has('petstore')).toBe(true)
  })

  it('name an import that is no operation, where it is used', async () => {
    const dir = await project({
      '.specbook/specbook.config.ts': config(),
      'requests/find.req.ts': request('FindPetsByTagz'),
    })
    await generated(dir)
    const used = await usedMetadata(
      { root: dir, config: { services: { petstore: {} } } as never },
      join(dir, '.generated'),
    )
    expect(used.missing).toEqual(['FindPetsByTagz (petstore)'])
  })
})

describe('specbook check', () => {
  it('reports an imported operation the spec does not have', async () => {
    const dir = await project({
      '.specbook/specbook.config.ts': config(),
      'openapi/petstore.json': await (await import('node:fs/promises')).readFile(
        join(example, 'openapi/petstore.json'),
        'utf8',
      ),
      'requests/find.req.ts': request('FindPetsByTagz'),
    })
    await generated(dir)
    const loader = await createLoader(dir)
    const said: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => void said.push(a.join(' ')))
    try {
      const code = await checkCommand(await loadProject(dir, loader), loader)
      expect(code).toBe(1)
      expect(said.join('\n')).toContain('FindPetsByTagz is not an operation of "petstore"')
    } finally {
      log.mockRestore()
      await loader.close()
    }
  }, 60_000)
})
