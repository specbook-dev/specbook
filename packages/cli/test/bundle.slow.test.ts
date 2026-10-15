import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { generateCommand } from '../src/commands/generate'
import { buildCommand } from '../src/commands/ui'
import { createLoader } from '../src/load'
import { loadProject } from '../src/project'

const root = resolve(__dirname, '../../../apps/example')

async function files(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await files(p)))
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

describe('what the built site ships', () => {
  it('carries the page-side proxy helpers and none of the server-side proxy', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const out = await mkdtemp(join(tmpdir(), 'sb-bundle-'))
    afterAll(() => rm(out, { recursive: true, force: true }))
    const loader = await createLoader(root)
    afterAll(() => loader.close())
    const project = await loadProject(root, loader)
    await generateCommand(project, loader)
    await buildCommand(project, out)

    const sources = await Promise.all((await files(out)).map((f) => readFile(f, 'utf8')))
    const has = (s: string) => sources.some((src) => src.includes(s))

    // the scan reads real output: a string the UI really uses is found
    expect(has('Missing secrets')).toBe(true)

    // server-side proxy code must be tree-shaken out of every browser bundle: the SSRF policy, the
    // cross-site check, the extension's worker-side handler and Node's HTTP types
    for (const server of [
      'not reachable through this proxy',
      'cross-site requests are not accepted',
      'has not been allowed for this site',
      'private and local addresses',
      'numeric host forms are not allowed',
      'the upstream timed out',
      'node:http',
      'IncomingMessage',
    ])
      expect(has(server), `the browser bundle contains "${server}"`).toBe(false)
  }, 120_000)
})
