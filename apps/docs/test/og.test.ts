import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CARDS } from '../scripts/og.mjs'

describe('link previews', () => {
  it('has a card for the home page and each of the five pages, as a real 1200x630 PNG', () => {
    expect(CARDS.map((c: { slug: string }) => c.slug)).toEqual([
      'home',
      'develop',
      'document',
      'test',
      'monitor',
      'ai',
    ])
    for (const { slug } of CARDS as { slug: string }[]) {
      const file = resolve(import.meta.dirname, `../public/og/${slug}.png`)
      expect(existsSync(file), `public/og/${slug}.png (run node scripts/og.mjs)`).toBe(true)
      const png = readFileSync(file)
      expect(png.subarray(1, 4).toString()).toBe('PNG')
      expect(png.readUInt32BE(16)).toBe(1200)
      expect(png.readUInt32BE(20)).toBe(630)
    }
  })
})
