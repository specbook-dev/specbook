import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { slugify } from '../src/lib/slug'

const pages = join(process.cwd(), 'src/pages')
const sources = readdirSync(pages)
  .filter((f) => f.endsWith('.astro'))
  .map((f) => ({ name: f, text: readFileSync(join(pages, f), 'utf8') }))

describe('the address of a section', () => {
  it('is its title in lowercase with hyphens, and no punctuation', () => {
    expect(slugify('Add your spec')).toBe('add-your-spec')
    expect(slugify('Values pass by name, and the names are checked')).toBe(
      'values-pass-by-name-and-the-names-are-checked',
    )
    expect(slugify("It's a 'flow': run it!")).toBe('its-a-flow-run-it')
    expect(slugify('  Café  au  lait ')).toBe('cafe-au-lait')
  })
})

describe('the headings of the site’s pages', () => {
  it('are all made by the Heading component, so each can be linked to', () => {
    const raw = sources.filter((s) => /<h2 class="title"/.test(s.text)).map((s) => s.name)
    expect(raw).toEqual([])
    // and a page that has a heading imports the component
    for (const s of sources.filter((s) => /<Heading[ >]/.test(s.text)))
      expect(s.text, s.name).toContain("import Heading from '../components/Heading.astro'")
  })

  it('have a different address each on a page, so a link goes to one section', () => {
    for (const s of sources) {
      const titles = [...s.text.matchAll(/<Heading(?: id="([^"]+)")?>(.*?)<\/Heading>/g)].map(
        (m) => m[1] ?? slugify((m[2] ?? '').replace(/<[^>]*>/g, '')),
      )
      expect(new Set(titles).size, `${s.name}: ${titles.join(', ')}`).toBe(titles.length)
      for (const id of titles) expect(id, s.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })
})
