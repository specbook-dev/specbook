import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLlms, GUIDE, OUT } from '../scripts/llms.mjs'
import { PAGES } from '../src/lib/pages'

/** /llms.txt is the guide `specbook init` writes into a project, plus links. These keep the two from drifting, and the links real. */

describe('llms.txt', () => {
  it('is the guide plus the links: regenerate with `pnpm --filter docs llms` after the guide changes', async () => {
    const guide = await readFile(GUIDE, 'utf8')
    expect(await readFile(OUT, 'utf8')).toBe(buildLlms(guide))
  })

  it('has the shape agents expect: a title, a one-paragraph summary, then sections', async () => {
    const text = await readFile(OUT, 'utf8')
    expect(text.startsWith('# Specbook\n\n> ')).toBe(true)
    for (const section of [
      '## Add a request',
      '## Asserts',
      '## Capture',
      '## Build a flow',
      '## Docs',
      '## Optional',
    ])
      expect(text, section).toContain(section)
  })

  it('links only to absolute addresses, and every address on this site is a page that exists', async () => {
    const text = await readFile(OUT, 'utf8')
    const links = [...text.matchAll(/\]\((\S+?)\)/g)].map((m) => m[1] as string)
    expect(links.length).toBeGreaterThan(8)
    const reference = join(__dirname, '../src/content/docs/reference')
    for (const url of links) {
      expect(url, url).toMatch(/^https:\/\//)
      if (!url.startsWith('https://docs.specbook.dev/')) continue
      const slug = url.replace('https://docs.specbook.dev/', '').replace(/\/$/, '')
      const page = slug.startsWith('reference/')
        ? existsSync(join(reference, `${slug.slice('reference/'.length)}.mdx`))
        : PAGES.some((p) => p.slug === slug)
      expect(page, url).toBe(true)
    }
  })
})
