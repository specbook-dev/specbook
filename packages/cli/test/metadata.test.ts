import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeMetadata } from '../src/commands/metadata'
import type { Loader } from '../src/load'

describe('specbook.json', () => {
  it('is never seen half written, however large it is and however many generations race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sb-meta-'))
    try {
      const outDir = join(root, '.generated')
      // big enough that the metadata is over 512 KiB: Node writes a file that size in more than one piece,
      // and a reader that arrives between the pieces sees a document cut off at exactly 524288 bytes
      const operations = Array.from({ length: 2500 }, (_, i) => ({
        id: `Operation${i}`,
        summary: `Operation number ${i} does something useful.`,
        method: 'GET',
        path: `/things/${i}`,
        tags: ['things'],
        examples: [{ name: 'default', source: 'generated' }],
      }))
      await mkdir(join(outDir, 'big'), { recursive: true })
      await writeFile(
        join(outDir, 'big/manifest.json'),
        JSON.stringify({ service: 'big', title: 'Big', operations }),
      )
      const loader = { import: async () => ({}), close: async () => {} } as Loader
      const file = join(outDir, 'specbook.json')
      await writeMetadata(root, outDir, loader)
      expect((await readFile(file)).length).toBeGreaterThan(600_000)

      let writing = true
      const torn: string[] = []
      const reader = (async () => {
        while (writing) {
          try {
            JSON.parse(await readFile(file, 'utf8'))
          } catch (e) {
            torn.push(e instanceof Error ? e.message : String(e))
          }
        }
      })()
      // two `specbook generate`s against one folder, as the example package and the CLI's own test are
      for (let round = 0; round < 8; round++)
        await Promise.all([1, 2, 3, 4].map(() => writeMetadata(root, outDir, loader)))
      writing = false
      await reader

      expect(torn).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
