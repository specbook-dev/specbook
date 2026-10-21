import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve(__dirname, '../scripts/assemble-site.mjs')

/** A stand-in for `dist-viewer`: an index page and hashed files. */
async function viewer(files: Record<string, string>, index = '<div id="app"></div>') {
  const dir = await mkdtemp(join(tmpdir(), 'sb-viewer-'))
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'index.html'), index)
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

describe('the landing page references', () => {
  it('carry a hash of the file, so a changed stylesheet is a new address', async () => {
    const site = await assemble(await viewer({ 'main-aaa.js': 'a' }))
    const html = await readFile(join(site, 'index.html'), 'utf8')
    const { createHash } = await import('node:crypto')
    for (const file of ['landing.css', 'landing.js', 'screenshot.png', 'badge.svg']) {
      const hash = createHash('sha256')
        .update(await readFile(join(site, file)))
        .digest('hex')
        .slice(0, 10)
      expect(html, file).toContain(`./${file}?v=${hash}`)
    }
    // the viewer's own hashed files and its directory are left as they are
    expect(html).not.toMatch(/\.\/v1\/\?v=/)
  })

  it('leave a reference to a missing file alone', async () => {
    const site = await assemble(await viewer({ 'main-aaa.js': 'a' }))
    const html = await readFile(join(site, 'index.html'), 'utf8')
    expect(html).not.toMatch(/\?v=undefined/)
  })

  it('has the viewer declare the site’s stable sign-in callback, and ships that page with its own headers', async () => {
    const dist = await viewer(
      { 'main-aaa.js': 'a' },
      '<!doctype html><html><head><title>Specbook</title></head><body><div id="app"></div></body></html>',
    )
    const site = await assemble(dist)
    const index = await readFile(join(site, 'v1/index.html'), 'utf8')
    expect(index).toContain('<meta name="specbook-oauth-callback" content="/oauth/callback/" />')
    // and where an address it cannot read is sent: the hosted site has a landing page, a copy does not
    expect(index).toContain('<meta name="specbook-home" content="/" />')
    // in the head, before the page's own markup
    expect(index.indexOf('specbook-oauth-callback')).toBeLessThan(index.indexOf('<body>'))

    // the callback page and its script are at the unversioned address, with no inline script (the site's CSP)
    const page = await readFile(join(site, 'oauth/callback/index.html'), 'utf8')
    expect(page).toContain('<script src="./callback.js"></script>')
    expect(page).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
    expect(
      (await readFile(join(site, 'oauth/callback/callback.js'), 'utf8')).length,
    ).toBeGreaterThan(0)

    // not cached, not indexed
    const headers = await readFile(join(site, '_headers'), 'utf8')
    expect(headers).toMatch(
      /\/oauth\/callback\/\*\n\s+Cache-Control: no-cache, no-transform\n\s+X-Robots-Tag: noindex/,
    )

    // the build it came from is untouched: a self-hosted copy keeps using its own address
    const own = await readFile(join(dist, 'index.html'), 'utf8')
    expect(own).not.toContain('specbook-oauth-callback')
    expect(own).not.toContain('specbook-home')
  })

  it('lets only the home page run the analytics beacon, and keeps it off the viewer and the sign-in page', async () => {
    const site = await assemble(await viewer({ 'main-aaa.js': 'a' }))
    const headers = await readFile(join(site, '_headers'), 'utf8')
    const rule = (path: string) =>
      headers.split('\n\n').find((block) => block.split('\n').includes(path)) ?? ''
    const beacon = 'https://static.cloudflareinsights.com'
    // every path but the home page: this origin's scripts only
    expect(rule('/*')).toContain("script-src 'self';")
    expect(rule('/*')).not.toContain(beacon)
    // the home page lets go of that policy and sets its own
    expect(rule('/')).toContain('! Content-Security-Policy')
    expect(rule('/')).toContain(`script-src 'self' ${beacon};`)
    // the viewer's page and the sign-in return are not given to Cloudflare to add a script to
    expect(rule('/v1/')).toContain('no-transform')
    expect(rule('/v1/index.html')).toContain('no-transform')
    expect(rule('/oauth/callback/*')).toContain('no-transform')
    for (const path of ['/v1/', '/v1/index.html', '/oauth/callback/*'])
      expect(rule(path)).not.toContain(beacon)
  })

  it('still declares it when the viewer’s index has no head to put it in', async () => {
    const site = await assemble(await viewer({ 'main-aaa.js': 'a' }))
    expect(await readFile(join(site, 'v1/index.html'), 'utf8')).toContain('specbook-oauth-callback')
  })
})
