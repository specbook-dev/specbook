import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkSite, LIMITS } from '../scripts/check-site.mjs'

async function site(files: Record<string, string | number>) {
  const dir = await mkdtemp(join(tmpdir(), 'sb-site-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), typeof content === 'number' ? 'x'.repeat(content) : content)
  }
  return dir
}

const ok = { 'index.html': '<script src="/app.js"></script>', 'app.js': 'a', 'sw.js': 'b' }

describe('the limits a site is checked against', () => {
  it('passes a small site and lists the largest files', async () => {
    const r = await checkSite(await site(ok))
    expect(r.problems).toEqual([])
    expect(r.files).toBe(3)
    expect(r.largest[0].file).toBeTruthy()
  })

  it('names too many files, a file that is too big, and a site that is too heavy', async () => {
    const dir = await site({ ...ok, 'a/big.bin': 600 })
    const r = await checkSite(dir, { ...LIMITS, files: 3, file: 500, total: 500 })
    expect(r.problems.join('\n')).toMatch(/4 files/)
    expect(r.problems.join('\n')).toMatch(/big\.bin/)
    expect(r.problems.join('\n')).toMatch(/in all/)
  })

  it('notices a heavy home page and a missing or heavy service worker', async () => {
    const noise = Array.from({ length: 4000 }, (_, i) => String(Math.sin(i))).join(',')
    const heavy = await checkSite(await site({ ...ok, 'app.js': noise }), {
      ...LIMITS,
      homeScripts: 100,
    })
    expect(heavy.problems.join('\n')).toMatch(/home page loads/)
    const lacking = await checkSite(await site({ 'index.html': '<p>x</p>' }))
    expect(lacking.problems.join('\n')).toMatch(/no sw\.js/)
    const slow = await checkSite(await site({ ...ok, 'sw.js': noise }), { ...LIMITS, worker: 100 })
    expect(slow.problems.join('\n')).toMatch(/sw\.js is/)
  })
})
