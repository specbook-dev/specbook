import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve(__dirname, '../scripts/assemble-site.mjs')

/** A stand-in for `dist-viewer`: an index page and hashed files. */
async function viewer(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'sb-viewer-'))
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'index.html'), '<div id="app"></div>')
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, 'assets', name), body)
  return dir
}

const assemble = async (v: string, ...extra: string[]) => {
  const out = await mkdtemp(join(tmpdir(), 'sb-site-'))
  execFileSync('node', [script, '--out', out, '--viewer', v, ...extra], { stdio: 'ignore' })
  return out
}
const assets = async (site: string) => (await readdir(join(site, 'v1/assets'))).sort()
const manifest = async (site: string) =>
  JSON.parse(await readFile(join(site, 'v1/asset-manifest.json'), 'utf8')) as {
    builds: { files: string[] }[]
  }

describe('assembling the site', () => {
  it('carries the last builds’ files into the next, so a page loaded from one still finds them', async () => {
    const one = await assemble(
      await viewer({ 'main-aaa.js': 'a', 'main-aaa.css': 'a', 'worker-111.js': 'w' }),
    )
    expect(await assets(one)).toEqual(['main-aaa.css', 'main-aaa.js', 'worker-111.js'])

    const two = await assemble(
      await viewer({ 'main-bbb.js': 'b', 'main-bbb.css': 'b', 'worker-111.js': 'w' }),
      '--previous',
      one,
    )
    // the new build's files and the old build's, side by side
    expect(await assets(two)).toEqual([
      'main-aaa.css',
      'main-aaa.js',
      'main-bbb.css',
      'main-bbb.js',
      'worker-111.js',
    ])
    expect((await manifest(two)).builds).toHaveLength(2)
    expect(await readFile(join(two, 'v1/assets/main-aaa.js'), 'utf8')).toBe('a')
  })

  it('preloads only the current build’s files, not the carried ones', async () => {
    const one = await assemble(await viewer({ 'main-aaa.js': 'a' }))
    const two = await assemble(await viewer({ 'main-bbb.js': 'b' }), '--previous', one)
    const html = await readFile(join(two, 'index.html'), 'utf8')
    const list = JSON.parse(/id="viewer-assets">([^<]*)</.exec(html)?.[1] ?? '{}') as {
      modules: string[]
    }
    expect(list.modules).toEqual(['./v1/assets/main-bbb.js'])
  })

  it('keeps only the last few builds', async () => {
    let site = await assemble(await viewer({ 'a-1.js': '1' }), '--keep', '2')
    site = await assemble(await viewer({ 'a-2.js': '2' }), '--previous', site, '--keep', '2')
    site = await assemble(await viewer({ 'a-3.js': '3' }), '--previous', site, '--keep', '2')
    // two builds held: the newest and the one before it
    expect(await assets(site)).toEqual(['a-2.js', 'a-3.js'])
    expect((await manifest(site)).builds).toHaveLength(2)
  })

  it('does not count a redeploy of the same build twice, and works with no earlier site', async () => {
    const v = await viewer({ 'main-x.js': 'x' })
    const one = await assemble(v)
    const again = await assemble(v, '--previous', one)
    expect((await manifest(again)).builds).toHaveLength(1)
    expect(await assets(again)).toEqual(['main-x.js'])
    // a first deploy, with an address that answers nothing, still assembles
    const none = await assemble(v, '--previous', join(tmpdir(), 'sb-no-such-site'))
    expect(await assets(none)).toEqual(['main-x.js'])
  })
})
