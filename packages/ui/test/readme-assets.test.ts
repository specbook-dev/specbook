import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The README's pictures are repository paths, not URLs: a rename or a missed regeneration shows up as a
// broken image on the project's front page, so check they exist.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const readme = readFileSync(resolve(root, 'README.md'), 'utf8')

describe('README images', () => {
  const paths = [...readme.matchAll(/(?:src|srcset)="((?!https?:)[^"]+\.(?:png|svg))"/g)].map(
    (m) => m[1] as string,
  )

  it('references at least the logo and the screenshots', () => {
    expect(paths.length).toBeGreaterThanOrEqual(3)
  })

  it.each(paths)('%s exists', (path) => {
    expect(existsSync(resolve(root, path))).toBe(true)
  })
})
