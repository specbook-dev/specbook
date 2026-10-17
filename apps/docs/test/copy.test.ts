import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

function files(dir: string, exts: string[]): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return files(path, exts)
    return exts.some((x) => e.name.endsWith(x)) ? [path] : []
  })
}

/** The words a visitor reads: the pages, the reference and the notes beside the demo's operations. */
const prose = [
  ...files('src/pages', ['.astro']),
  ...files('src/content', ['.mdx']),
  ...files('src/components', ['.astro']),
  'src/lib/pages.ts',
  ...files('demo/requests', ['.md']),
  ...files('demo/sequences', ['.md']),
]

const text = (file: string) => readFileSync(join(root, file), 'utf8')
/** A page's template, without the script that opens it. */
const template = (file: string) => {
  const s = text(file)
  return file.endsWith('.astro') && s.startsWith('---') ? s.split('---').slice(2).join('---') : s
}

describe('the copy', () => {
  it('has no em dash or en dash', () => {
    const found = prose.filter((f) => /[–—]/.test(text(f)))
    expect(found.map((f) => relative(root, f))).toEqual([])
  })

  it('does not end a line in text and start the next with a link or code, which drops the space between them', () => {
    // the page is compressed, so "familiar\n<a>" reads "familiar<a>": write `{' '}` after the text instead
    const found: string[] = []
    for (const f of prose.filter((x) => x.endsWith('.astro'))) {
      const body = template(f)
      for (const m of body.matchAll(
        /([A-Za-z0-9,.:)'"])\n[ \t]+(<(?:a|code|strong|em|button|span|kbd)\b)/g,
      )) {
        const line = body.slice(0, m.index).split('\n').length
        found.push(`${f} (template line ${line})`)
      }
    }
    expect(found).toEqual([])
  })
})
