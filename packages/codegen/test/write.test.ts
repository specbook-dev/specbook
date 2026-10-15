import { mkdtemp, readdir, readFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateToDisk } from '../src/write'

const petstore = resolve(__dirname, 'fixtures/petstore3.json')

describe('generateToDisk', () => {
  it('leaves unchanged files untouched, so a second run changes nothing a watcher would see', async () => {
    const out = await mkdtemp(join(tmpdir(), 'sb-write-'))
    const first = await generateToDisk({ spec: petstore, service: 'pets', outDir: out })
    const manifest = join(first.root, 'manifest.json')
    // age the file: if it were rewritten its time would jump to now
    const old = new Date(Date.now() - 60_000)
    await utimes(manifest, old, old)
    await generateToDisk({ spec: petstore, service: 'pets', outDir: out })
    expect((await stat(manifest)).mtimeMs).toBeCloseTo(old.getTime(), -3)
  })

  it('never shows a reader a partial file while it writes, and leaves no temp files behind', async () => {
    const out = await mkdtemp(join(tmpdir(), 'sb-write-'))
    const first = await generateToDisk({ spec: petstore, service: 'pets', outDir: out })
    const file = join(first.root, 'manifest.json')
    const want = await readFile(file, 'utf8')
    // make every run rewrite it: another service name changes the manifest's content
    let bad = 0
    let stop = false
    const reader = (async () => {
      while (!stop) {
        const text = await readFile(file, 'utf8').catch(() => undefined)
        if (text !== undefined) {
          try {
            JSON.parse(text)
          } catch {
            bad++
          }
        }
      }
    })()
    for (let i = 0; i < 6; i++)
      await generateToDisk({ spec: petstore, service: 'pets', outDir: out, corePackage: `@x/${i}` })
    stop = true
    await reader
    expect(bad).toBe(0)
    expect(JSON.parse(want).service).toBe('pets')
    const leftovers = (await readdir(first.root, { recursive: true })).filter((f) =>
      String(f).endsWith('.tmp'),
    )
    expect(leftovers).toEqual([])
  })
})
