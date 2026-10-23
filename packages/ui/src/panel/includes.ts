/** What an author's page can place with `<!-- specbook: name -->` on a line of its own. */
export const BLOCKS = [
  'description',
  'auth',
  'path',
  'query',
  'headers',
  'params',
  'body',
  'responses',
  'examples',
] as const

export type BlockName = (typeof BLOCKS)[number]

export type Segment = { html: string } | { block: BlockName }

const isBlock = (name: string): name is BlockName => (BLOCKS as readonly string[]).includes(name)

// markdown turns a comment on a line of its own into a block of its own; one inside a sentence stays in its paragraph
const INCLUDE = /(^|\n)<!--\s*specbook:\s*([a-z]+)\s*-->/g

/**
 * The page's HTML cut at the places the author put a generated block. A comment that names no block, or that
 * sits inside a paragraph, stays where it is (a comment shows nothing).
 */
export function splitIncludes(html: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of html.matchAll(INCLUDE)) {
    const name = m[2] as string
    if (!isBlock(name)) continue
    const start = (m.index as number) + (m[1] as string).length
    if (start > last) out.push({ html: html.slice(last, start) })
    out.push({ block: name })
    last = start + m[0].length - (m[1] as string).length
  }
  if (last < html.length) out.push({ html: html.slice(last) })
  return out.filter((s) => !('html' in s) || s.html.trim() !== '')
}
