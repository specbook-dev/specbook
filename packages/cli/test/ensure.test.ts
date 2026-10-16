import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkCommand } from '../src/commands/check'
import { ensureGenerated } from '../src/commands/ensure'
import { initCommand } from '../src/commands/init'
import type { Loader } from '../src/load'
import type { Project } from '../src/project'

const fixture = resolve(__dirname, '../../codegen/test/fixtures/petstore3.json')
const loader: Loader = { import: async () => ({}) as never, close: async () => {} }

async function project(): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), 'sb-ensure-'))
  await mkdir(join(root, 'openapi'), { recursive: true })
  await mkdir(join(root, '.specbook'), { recursive: true })
  await copyFile(fixture, join(root, 'openapi/petstore.json'))
  const configFile = join(root, '.specbook/specbook.config.ts')
  await writeFile(configFile, 'export default {}\n')
  return {
    root,
    configFile,
    config: {
      project: 't',
      services: {
        petstore: { spec: './openapi/petstore.json', baseUrl: { live: 'https://x.test' } },
      },
    },
  }
}

describe('generated code that is not committed', () => {
  afterEach(() => vi.restoreAllMocks())

  it('is generated when missing, left alone when fresh, and regenerated when the spec changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = await project()
    expect(existsSync(join(p.root, '.generated/petstore/manifest.json'))).toBe(false)

    expect(await ensureGenerated(p, loader)).toEqual(['petstore'])
    expect(existsSync(join(p.root, '.generated/petstore/manifest.json'))).toBe(true)

    expect(await ensureGenerated(p, loader)).toEqual([])

    // the spec is edited after the output was written
    const later = new Date(Date.now() + 60_000)
    await utimes(join(p.root, 'openapi/petstore.json'), later, later)
    expect(await ensureGenerated(p, loader)).toEqual(['petstore'])
  })

  it('does not regenerate every time when the spec is newer but generates the same code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = await project()
    await ensureGenerated(p, loader)
    // the spec was checked out again after the output was made: newer, but the same document
    const hourAgo = new Date(Date.now() - 3_600_000)
    const halfHourAgo = new Date(Date.now() - 1_800_000)
    for (const f of ['manifest.json', 'opmeta.json'])
      await utimes(join(p.root, '.generated/petstore', f), hourAgo, hourAgo)
    await utimes(join(p.root, 'openapi/petstore.json'), halfHourAgo, halfHourAgo)

    expect(await ensureGenerated(p, loader)).toEqual(['petstore'])
    // the output is the same, so nothing was rewritten, and it must still count as up to date
    expect(await ensureGenerated(p, loader)).toEqual([])
    expect(await ensureGenerated(p, loader)).toEqual([])
  })

  it('check regenerates local output instead of reporting drift, and still validates the spec', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const p = await project()
    // stale, hand-damaged local output must not fail the check
    await ensureGenerated(p, loader)
    await writeFile(join(p.root, '.generated/petstore/index.ts'), '// edited\n')
    const later = new Date(Date.now() + 60_000)
    await utimes(join(p.root, 'openapi/petstore.json'), later, later)

    expect(await checkCommand(p, loader)).toBe(0)
    expect(log.mock.calls.flat().join('\n')).not.toContain('out of date')
    expect(await readFile(join(p.root, '.generated/petstore/index.ts'), 'utf8')).not.toBe(
      '// edited\n',
    )
  })

  it('check does report drift once the generated code is committed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const p = await project()
    execFileSync('git', ['init', '-q'], { cwd: p.root })
    await ensureGenerated(p, loader)
    execFileSync('git', ['add', '-f', '.generated'], { cwd: p.root })
    await writeFile(join(p.root, '.generated/petstore/index.ts'), '// edited\n')

    expect(await checkCommand(p, loader)).toBe(1)
    expect(log.mock.calls.flat().join('\n')).toContain('generated code is out of date')
  })
})

describe('init', () => {
  it('ignores generated code and regenerates it after install', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = await mkdtemp(join(tmpdir(), 'sb-init-'))
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'vitest' } }),
    )
    await writeFile(join(dir, '.gitignore'), 'node_modules\n')
    await initCommand(dir)

    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(pkg.scripts).toEqual({ test: 'vitest', prepare: 'specbook generate' })
    expect(pkg.imports['#api/*']).toBe('./.generated/*/index.ts')
    const ignore = (await readFile(join(dir, '.gitignore'), 'utf8')).split('\n')
    expect(ignore).toEqual(
      expect.arrayContaining(['node_modules', '.generated', '.specbook/secrets.local.env']),
    )

    // running it again changes nothing
    await initCommand(dir)
    expect(
      (await readFile(join(dir, '.gitignore'), 'utf8'))
        .split('\n')
        .filter((l) => l === '.generated'),
    ).toHaveLength(1)
    expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).scripts.prepare).toBe(
      'specbook generate',
    )
  })

  it('keeps a prepare script the project already has', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = await mkdtemp(join(tmpdir(), 'sb-init2-'))
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { prepare: 'husky' } }),
    )
    await initCommand(dir)
    expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).scripts.prepare).toBe(
      'husky',
    )
  })
})
